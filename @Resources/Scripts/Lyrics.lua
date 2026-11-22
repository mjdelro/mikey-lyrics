-- mikey lyrics - Synchronous & Plain Lyrics Engine for Rainmeter (Lua 5.1)

local STATE = {
    -- Track metadata tracking & debouncing
    lastRawKey = "",
    pendingKey = "",
    stableTicks = 0,
    fetchedKey = "",
    fetchStage = 0, -- 0 = idle, 1 = /api/get, 2 = /api/search

    -- Parsed lyrics data
    hasSynced = false,
    syncedLines = {}, -- array of { time = number (sec), text = string }
    plainLyrics = "",
    isInstrumental = false,
    statusText = "No track playing.",

    -- Display & sync state
    syncEnabled = true,
    syncOffsetSec = 0,
    contextLines = 4,
    activeIndex = -1,
    activeMode = "plain", -- "synced" or "plain"

    -- Sub-second playback interpolation
    lastReportedPos = -1,
    lastPosClock = 0,
    lastPlayerState = 0,

    -- UI state
    scrollNum = 0,
    scrollStep = 20,
    lyricSize = 10,
    lyricStep = 1,
    minLyricSize = 8,
    maxLyricSize = 24,
    vinylMode = false,
    vinylAngle = 0,
    vinylStepDeg = 4.5, -- 4.5 deg per 100ms tick = ~8s per revolution
}

local mTitle, mArtist, mAlbum, mDuration, mPosition, mState, mLyricsBody
local applyVinylMode

-- ==========================================
-- Utility: URL Encoding (RFC 3986)
-- ==========================================
local function urlEncode(str)
    if not str or str == "" then return "" end
    str = tostring(str):gsub("\r?\n", " ")
    return (str:gsub("([^%w%-_%.~])", function(c)
        return string.format("%%%02X", string.byte(c))
    end))
end

-- ==========================================
-- Utility: UTF-8 Codepoint Encoder (Lua 5.1)
-- ==========================================
local function encodeUTF8(cp)
    if cp < 0x80 then
        return string.char(cp)
    elseif cp < 0x800 then
        return string.char(
            0xC0 + math.floor(cp / 0x40),
            0x80 + (cp % 0x40)
        )
    elseif cp < 0x10000 then
        return string.char(
            0xE0 + math.floor(cp / 0x1000),
            0x80 + (math.floor(cp / 0x40) % 0x40),
            0x80 + (cp % 0x40)
        )
    elseif cp <= 0x10FFFF then
        return string.char(
            0xF0 + math.floor(cp / 0x40000),
            0x80 + (math.floor(cp / 0x1000) % 0x40),
            0x80 + (math.floor(cp / 0x40) % 0x40),
            0x80 + (cp % 0x40)
        )
    end
    return ""
end

-- ==========================================
-- Lightweight JSON Decoder (Lua 5.1)
-- ==========================================
local function decodeJSON(str)
    if not str or str == "" then return nil end
    local pos = 1
    local len = #str

    local function skipWS()
        local _, e = str:find("^[ \t\r\n]+", pos)
        if e then pos = e + 1 end
    end

    local parseValue

    local function parseString()
        pos = pos + 1 -- skip opening "
        local parts = {}
        while pos <= len do
            local nextSpecial = str:find('["\\]', pos)
            if not nextSpecial then return nil end
            if nextSpecial > pos then
                parts[#parts + 1] = str:sub(pos, nextSpecial - 1)
            end
            local ch = str:sub(nextSpecial, nextSpecial)
            if ch == '"' then
                pos = nextSpecial + 1
                return table.concat(parts)
            else
                local esc = str:sub(nextSpecial + 1, nextSpecial + 1)
                if esc == '"' or esc == "\\" or esc == "/" then
                    parts[#parts + 1] = esc
                    pos = nextSpecial + 2
                elseif esc == "n" then
                    parts[#parts + 1] = "\n"
                    pos = nextSpecial + 2
                elseif esc == "r" then
                    parts[#parts + 1] = "\r"
                    pos = nextSpecial + 2
                elseif esc == "t" then
                    parts[#parts + 1] = "\t"
                    pos = nextSpecial + 2
                elseif esc == "b" then
                    parts[#parts + 1] = "\b"
                    pos = nextSpecial + 2
                elseif esc == "f" then
                    parts[#parts + 1] = "\f"
                    pos = nextSpecial + 2
                elseif esc == "u" then
                    local hex = str:sub(nextSpecial + 2, nextSpecial + 5)
                    local code = tonumber(hex, 16)
                    if not code then return nil end
                    pos = nextSpecial + 6
                    -- Handle UTF-16 surrogate pairs
                    if code >= 0xD800 and code <= 0xDBFF and str:sub(pos, pos + 1) == "\\u" then
                        local lowHex = str:sub(pos + 2, pos + 5)
                        local low = tonumber(lowHex, 16)
                        if low and low >= 0xDC00 and low <= 0xDFFF then
                            code = 0x10000 + (code - 0xD800) * 0x400 + (low - 0xDC00)
                            pos = pos + 6
                        end
                    end
                    parts[#parts + 1] = encodeUTF8(code)
                else
                    parts[#parts + 1] = esc
                    pos = nextSpecial + 2
                end
            end
        end
        return nil
    end

    local function parseNumber()
        local _, e, numStr = str:find("^(%-?%d+%.?%d*[eE]?[%+%-]?%d*)", pos)
        if not e then return nil end
        pos = e + 1
        return tonumber(numStr)
    end

    local function parseArray()
        pos = pos + 1 -- skip [
        local arr = {}
        skipWS()
        if str:sub(pos, pos) == "]" then
            pos = pos + 1
            return arr
        end
        while pos <= len do
            skipWS()
            local val = parseValue()
            arr[#arr + 1] = val
            skipWS()
            local ch = str:sub(pos, pos)
            if ch == "]" then
                pos = pos + 1
                return arr
            elseif ch == "," then
                pos = pos + 1
            else
                return nil
            end
        end
        return nil
    end

    local function parseObject()
        pos = pos + 1 -- skip {
        local obj = {}
        skipWS()
        if str:sub(pos, pos) == "}" then
            pos = pos + 1
            return obj
        end
        while pos <= len do
            skipWS()
            if str:sub(pos, pos) ~= '"' then return nil end
            local key = parseString()
            if not key then return nil end
            skipWS()
            if str:sub(pos, pos) ~= ":" then return nil end
            pos = pos + 1
            skipWS()
            local val = parseValue()
            obj[key] = val
            skipWS()
            local ch = str:sub(pos, pos)
            if ch == "}" then
                pos = pos + 1
                return obj
            elseif ch == "," then
                pos = pos + 1
            else
                return nil
            end
        end
        return nil
    end

    parseValue = function()
        skipWS()
        local ch = str:sub(pos, pos)
        if ch == '"' then
            return parseString()
        elseif ch == "{" then
            return parseObject()
        elseif ch == "[" then
            return parseArray()
        elseif ch == "t" and str:sub(pos, pos + 3) == "true" then
            pos = pos + 4
            return true
        elseif ch == "f" and str:sub(pos, pos + 4) == "false" then
            pos = pos + 5
            return false
        elseif ch == "n" and str:sub(pos, pos + 3) == "null" then
            pos = pos + 4
            return nil
        else
            return parseNumber()
        end
    end

    return parseValue()
end

-- ==========================================
-- LRC Parser
-- ==========================================
local function trim(s)
    return (s:gsub("^%s+", ""):gsub("%s+$", ""))
end

local function parseLRC(lrcText)
    if not lrcText or lrcText == "" then return {} end
    local lines = {}
    for rawLine in (lrcText .. "\n"):gmatch("(.-)\r?\n") do
        local timestamps = {}
        local rest = rawLine
        while true do
            local m, s, frac, after = rest:match("^%[(%d+):(%d+)%.?(%d*)%](.*)")
            if not m then break end
            local sec = tonumber(m) * 60 + tonumber(s)
            if frac and frac ~= "" then
                sec = sec + tonumber("0." .. frac)
            end
            timestamps[#timestamps + 1] = sec
            rest = after
        end
        if #timestamps > 0 then
            local lyricText = trim(rest)
            for i = 1, #timestamps do
                lines[#lines + 1] = {
                    time = timestamps[i],
                    text = lyricText,
                }
            end
        end
    end
    table.sort(lines, function(a, b) return a.time < b.time end)
    return lines
end

-- Binary search: returns index of last line with time <= posSec (0 if before first line)
local function findActiveLineIndex(lines, posSec)
    local lo, hi = 1, #lines
    local result = 0
    while lo <= hi do
        local mid = math.floor((lo + hi) / 2)
        if lines[mid].time <= posSec then
            result = mid
            lo = mid + 1
        else
            hi = mid - 1
        end
    end
    return result
end

-- ==========================================
-- Rainmeter Rendering Helpers
-- ==========================================
local function setMeterText(meterName, text)
    SKIN:Bang("!SetOption", meterName, "Text", text)
end

local function updateSyncToggleIcon()
    if STATE.hasSynced then
        SKIN:Bang("!ShowMeter", "MeterSyncToggle")
        if STATE.syncEnabled then
            SKIN:Bang("!SetOption", "MeterSyncToggle", "Text", "sync")
            SKIN:Bang("!SetOption", "MeterSyncToggle", "ToolTipText", "Synced lyrics: ON (click for plain)")
        else
            SKIN:Bang("!SetOption", "MeterSyncToggle", "Text", "sync_disabled")
            SKIN:Bang("!SetOption", "MeterSyncToggle", "ToolTipText", "Synced lyrics: OFF (click for synced)")
        end
        SKIN:Bang("!UpdateMeter", "MeterSyncToggle")
    else
        SKIN:Bang("!HideMeter", "MeterSyncToggle")
    end
end

local function showPlainMode(text)
    STATE.activeMode = "plain"
    STATE.activeIndex = -1
    SKIN:Bang("!HideMeterGroup", "SyncedLyrics")
    SKIN:Bang("!ShowMeterGroup", "PlainLyrics")
    setMeterText("MeterLyrics", text)
    SKIN:Bang("!SetOption", "MeterLyrics", "Y", tostring(40 - STATE.scrollNum))
    updateSyncToggleIcon()
    SKIN:Bang("!UpdateMeterGroup", "PlainLyrics")
    SKIN:Bang("!Redraw")
end

local function renderSyncedWindow(idx)
    local lines = STATE.syncedLines
    local total = #lines
    local ctx = STATE.contextLines

    local prevParts = {}
    local startPrev = math.max(1, idx - ctx)
    for i = startPrev, idx - 1 do
        local t = lines[i].text
        prevParts[#prevParts + 1] = (t ~= "" and t or "• • •")
    end

    local currentText = ""
    if idx >= 1 and idx <= total then
        currentText = lines[idx].text
        if currentText == "" then
            currentText = "• • •"
        end
    elseif total > 0 then
        currentText = "♪"
    end

    local nextParts = {}
    local startNext = math.max(1, idx + 1)
    local endNext = math.min(total, idx + ctx + 1)
    for i = startNext, endNext do
        local t = lines[i].text
        nextParts[#nextParts + 1] = (t ~= "" and t or "• • •")
    end

    setMeterText("MeterLyricsPrev", table.concat(prevParts, "\n"))
    setMeterText("MeterLyricsCurrent", currentText)
    setMeterText("MeterLyricsNext", table.concat(nextParts, "\n"))
    SKIN:Bang("!UpdateMeterGroup", "SyncedLyrics")
    SKIN:Bang("!Redraw")
end

local function showSyncedMode(posSec)
    STATE.activeMode = "synced"
    SKIN:Bang("!HideMeterGroup", "PlainLyrics")
    SKIN:Bang("!ShowMeterGroup", "SyncedLyrics")
    updateSyncToggleIcon()
    local idx = findActiveLineIndex(STATE.syncedLines, posSec + STATE.syncOffsetSec)
    STATE.activeIndex = idx
    renderSyncedWindow(idx)
end

local function getInterpolatedPosition()
    local rawPos = mPosition:GetValue()
    local playState = mState:GetValue()
    local now = os.clock()

    if rawPos ~= STATE.lastReportedPos or playState ~= STATE.lastPlayerState then
        STATE.lastReportedPos = rawPos
        STATE.lastPosClock = now
        STATE.lastPlayerState = playState
        return rawPos
    end

    if playState == 1 then
        local elapsed = now - STATE.lastPosClock
        if elapsed < 0 then elapsed = 0 end
        if elapsed > 1.2 then elapsed = 1.2 end
        return rawPos + elapsed
    end

    return rawPos
end

-- ==========================================
-- LRCLIB Fetching & Selection
-- ==========================================
local function triggerWebFetch(url)
    SKIN:Bang("!SetOption", "MeasureLyricsRaw", "URL", url)
    SKIN:Bang("!CommandMeasure", "MeasureLyricsRaw", "Update")
end

local function fetchExact(title, artist, album, duration)
    STATE.fetchStage = 1
    local url = "https://lrclib.net/api/get?track_name=" .. urlEncode(title)
        .. "&artist_name=" .. urlEncode(artist)
    if album and album ~= "" then
        url = url .. "&album_name=" .. urlEncode(album)
    end
    if duration and duration > 0 then
        url = url .. "&duration=" .. tostring(math.floor(duration + 0.5))
    end
    triggerWebFetch(url)
end

local function fetchSearchFallback(title, artist)
    STATE.fetchStage = 2
    local url = "https://lrclib.net/api/search?track_name=" .. urlEncode(title)
        .. "&artist_name=" .. urlEncode(artist)
    triggerWebFetch(url)
end

local function pickBestSearchResult(results, targetDuration)
    if type(results) ~= "table" or #results == 0 then return nil end
    local bestItem = nil
    local bestScore = -1e9

    for i = 1, #results do
        local item = results[i]
        if type(item) == "table" then
            local score = 0
            local hasSync = type(item.syncedLyrics) == "string" and item.syncedLyrics ~= ""
            local hasPlain = type(item.plainLyrics) == "string" and item.plainLyrics ~= ""
            if hasSync then
                score = score + 1000
            elseif hasPlain then
                score = score + 500
            elseif item.instrumental then
                score = score + 100
            end

            if targetDuration and targetDuration > 0 and type(item.duration) == "number" and item.duration > 0 then
                local diff = math.abs(item.duration - targetDuration)
                if diff <= 1.5 then
                    score = score + 550 - diff * 20
                elseif diff <= 3 then
                    score = score + 380 - diff * 25
                elseif diff <= 6 then
                    score = score + 180 - diff * 20
                elseif diff <= 12 then
                    score = score + 40 - diff * 10
                else
                    score = score - (100 + diff * 4)
                end
            end

            -- Slight preference for earlier results on tie
            score = score - (i * 0.1)

            if score > bestScore then
                bestScore = score
                bestItem = item
            end
        end
    end
    return bestItem
end

local function applyLyricsRecord(record)
    STATE.hasSynced = false
    STATE.syncedLines = {}
    STATE.plainLyrics = ""
    STATE.isInstrumental = false
    STATE.scrollNum = 0

    if type(record) ~= "table" then
        STATE.statusText = "No lyrics found."
        showPlainMode(STATE.statusText)
        return
    end

    if record.instrumental == true and not record.syncedLyrics and not record.plainLyrics then
        STATE.isInstrumental = true
        STATE.statusText = "♪ Instrumental ♪"
        showPlainMode(STATE.statusText)
        return
    end

    if type(record.syncedLyrics) == "string" and record.syncedLyrics ~= "" then
        local parsed = parseLRC(record.syncedLyrics)
        if #parsed > 0 then
            STATE.hasSynced = true
            STATE.syncedLines = parsed
        end
    end

    if type(record.plainLyrics) == "string" and record.plainLyrics ~= "" then
        STATE.plainLyrics = record.plainLyrics:gsub("\r\n", "\n")
    elseif STATE.hasSynced then
        -- Derive plain lyrics from synced lines if plainLyrics is absent
        local plainParts = {}
        for i = 1, #STATE.syncedLines do
            plainParts[#plainParts + 1] = STATE.syncedLines[i].text
        end
        STATE.plainLyrics = table.concat(plainParts, "\n")
    end

    if STATE.hasSynced and STATE.syncEnabled then
        showSyncedMode(getInterpolatedPosition())
    elseif STATE.plainLyrics ~= "" then
        showPlainMode(STATE.plainLyrics)
    else
        STATE.statusText = "No lyrics found."
        showPlainMode(STATE.statusText)
    end
end

-- ==========================================
-- Rainmeter Lifecycle & Bang Callbacks
-- ==========================================
function Initialize()
    mTitle = SKIN:GetMeasure("MeasureTitle")
    mArtist = SKIN:GetMeasure("MeasureArtist")
    mAlbum = SKIN:GetMeasure("MeasureAlbum")
    mDuration = SKIN:GetMeasure("MeasureDuration")
    mPosition = SKIN:GetMeasure("MeasurePosition")
    mState = SKIN:GetMeasure("MeasureState")
    mLyricsBody = SKIN:GetMeasure("MeasureLyricsBody")

    STATE.syncEnabled = (tonumber(SKIN:GetVariable("SyncEnabled", "1")) or 1) ~= 0
    STATE.syncOffsetSec = (tonumber(SKIN:GetVariable("SyncOffset", "0")) or 0) / 1000.0
    STATE.contextLines = math.max(1, tonumber(SKIN:GetVariable("SyncContextLines", "4")) or 4)
    STATE.scrollStep = tonumber(SKIN:GetVariable("ScrollStep", "20")) or 20
    STATE.lyricSize = tonumber(SKIN:GetVariable("lyricSize", "10")) or 10
    STATE.lyricStep = tonumber(SKIN:GetVariable("lyricStep", "1")) or 1
    STATE.vinylMode = (tonumber(SKIN:GetVariable("VinylMode", "0")) or 0) ~= 0

    showPlainMode("No track playing.")
    applyVinylMode(false)
end

function Update()
    local title = trim(mTitle:GetStringValue() or "")
    local artist = trim(mArtist:GetStringValue() or "")
    local album = trim(mAlbum:GetStringValue() or "")
    local duration = mDuration:GetValue() or 0

    local rawKey = title .. "|" .. artist .. "|" .. album .. "|" .. tostring(math.floor(duration + 0.5))

    if rawKey ~= STATE.lastRawKey then
        STATE.lastRawKey = rawKey
        STATE.pendingKey = rawKey
        STATE.stableTicks = 0
    elseif STATE.pendingKey ~= "" and STATE.pendingKey ~= STATE.fetchedKey then
        STATE.stableTicks = STATE.stableTicks + 1
        -- Wait 2 ticks (~400ms) for Title/Artist/Album/Duration to settle together
        if STATE.stableTicks >= 2 then
            STATE.fetchedKey = STATE.pendingKey
            STATE.pendingKey = ""
            STATE.scrollNum = 0

            if title == "" then
                STATE.hasSynced = false
                STATE.syncedLines = {}
                STATE.plainLyrics = ""
                STATE.fetchStage = 0
                showPlainMode("No track playing.")
            else
                STATE.hasSynced = false
                STATE.syncedLines = {}
                STATE.plainLyrics = ""
                showPlainMode("Loading lyrics...")
                fetchExact(title, artist, album, duration)
            end
        end
    end

    -- Synced lyrics update loop
    if STATE.activeMode == "synced" and STATE.hasSynced then
        local posSec = getInterpolatedPosition()
        local idx = findActiveLineIndex(STATE.syncedLines, posSec + STATE.syncOffsetSec)
        if idx ~= STATE.activeIndex then
            STATE.activeIndex = idx
            renderSyncedWindow(idx)
        end
    end

    -- Spinning vinyl record animation while playing
    if STATE.vinylMode and mState:GetValue() == 1 then
        STATE.vinylAngle = (STATE.vinylAngle + STATE.vinylStepDeg) % 360
        SKIN:Bang("!SetOption", "MeterCoverVinyl", "ImageRotate", tostring(STATE.vinylAngle))
        SKIN:Bang("!UpdateMeter", "MeterCoverVinyl")
        SKIN:Bang("!Redraw")
    end

    return STATE.activeIndex
end

function OnLyricsFetched()
    local body = mLyricsBody:GetStringValue() or ""
    local decoded = decodeJSON(body)

    if STATE.fetchStage == 1 then
        if type(decoded) == "table" and (decoded.syncedLyrics or decoded.plainLyrics or decoded.instrumental) then
            STATE.fetchStage = 0
            applyLyricsRecord(decoded)
            return
        end
        -- Exact /api/get returned no usable lyrics; try /api/search fallback
        local title = trim(mTitle:GetStringValue() or "")
        local artist = trim(mArtist:GetStringValue() or "")
        if title ~= "" then
            fetchSearchFallback(title, artist)
        else
            STATE.fetchStage = 0
            applyLyricsRecord(nil)
        end
    elseif STATE.fetchStage == 2 then
        STATE.fetchStage = 0
        local duration = mDuration:GetValue() or 0
        local best = pickBestSearchResult(decoded, duration)
        applyLyricsRecord(best)
    end
end

function OnLyricsError()
    if STATE.fetchStage == 1 then
        local title = trim(mTitle:GetStringValue() or "")
        local artist = trim(mArtist:GetStringValue() or "")
        if title ~= "" then
            fetchSearchFallback(title, artist)
            return
        end
    end
    STATE.fetchStage = 0
    applyLyricsRecord(nil)
end

function ToggleSync()
    if not STATE.hasSynced then return end
    STATE.syncEnabled = not STATE.syncEnabled
    SKIN:Bang("!SetVariable", "SyncEnabled", STATE.syncEnabled and "1" or "0")
    if STATE.syncEnabled then
        showSyncedMode(getInterpolatedPosition())
    else
        STATE.scrollNum = 0
        showPlainMode(STATE.plainLyrics ~= "" and STATE.plainLyrics or STATE.statusText)
    end
end

function ScrollLyrics(delta)
    if STATE.activeMode ~= "plain" then return end
    local nextScroll = STATE.scrollNum + (tonumber(delta) or 0)
    if nextScroll < 0 then nextScroll = 0 end
    if nextScroll == STATE.scrollNum then return end
    STATE.scrollNum = nextScroll
    SKIN:Bang("!SetOption", "MeterLyrics", "Y", tostring(40 - STATE.scrollNum))
    SKIN:Bang("!UpdateMeter", "MeterLyrics")
    SKIN:Bang("!Redraw")
end

function AdjustFontSize(delta)
    local nextSize = STATE.lyricSize + (tonumber(delta) or 0)
    if nextSize < STATE.minLyricSize then nextSize = STATE.minLyricSize end
    if nextSize > STATE.maxLyricSize then nextSize = STATE.maxLyricSize end
    if nextSize == STATE.lyricSize then return end
    STATE.lyricSize = nextSize
    SKIN:Bang("!SetVariable", "lyricSize", tostring(STATE.lyricSize))
    SKIN:Bang("!SetOption", "MeterLyrics", "FontSize", tostring(STATE.lyricSize))
    SKIN:Bang("!SetOption", "MeterLyricsPrev", "FontSize", tostring(STATE.lyricSize))
    SKIN:Bang("!SetOption", "MeterLyricsCurrent", "FontSize", tostring(STATE.lyricSize + 2))
    SKIN:Bang("!SetOption", "MeterLyricsNext", "FontSize", tostring(STATE.lyricSize))
    if STATE.activeMode == "synced" then
        SKIN:Bang("!UpdateMeterGroup", "SyncedLyrics")
    else
        SKIN:Bang("!UpdateMeter", "MeterLyrics")
    end
    SKIN:Bang("!Redraw")
end

applyVinylMode = function(shouldRedraw)
    if STATE.vinylMode then
        SKIN:Bang("!HideMeter", "MeterCover")
        SKIN:Bang("!ShowMeter", "MeterCoverVinylMask")
        SKIN:Bang("!ShowMeter", "MeterCoverVinyl")
        SKIN:Bang("!ShowMeter", "MeterVinylRim")
        SKIN:Bang("!SetOption", "MeterCoverVinyl", "ImageRotate", tostring(STATE.vinylAngle))
    else
        STATE.vinylAngle = 0
        SKIN:Bang("!HideMeter", "MeterCoverVinylMask")
        SKIN:Bang("!HideMeter", "MeterCoverVinyl")
        SKIN:Bang("!HideMeter", "MeterVinylRim")
        SKIN:Bang("!ShowMeter", "MeterCover")
    end
    SKIN:Bang("!UpdateMeter", "MeterCover")
    SKIN:Bang("!UpdateMeter", "MeterCoverVinylMask")
    SKIN:Bang("!UpdateMeter", "MeterCoverVinyl")
    SKIN:Bang("!UpdateMeter", "MeterVinylRim")
    if shouldRedraw then
        SKIN:Bang("!Redraw")
    end
end

function ToggleVinyl()
    STATE.vinylMode = not STATE.vinylMode
    SKIN:Bang("!SetVariable", "VinylMode", STATE.vinylMode and "1" or "0")
    applyVinylMode(true)
end

-- Expose internals for offline unit testing (harmless in Rainmeter)
_TEST = {
    urlEncode = urlEncode,
    decodeJSON = decodeJSON,
    parseLRC = parseLRC,
    findActiveLineIndex = findActiveLineIndex,
    pickBestSearchResult = pickBestSearchResult,
    STATE = STATE,
}
