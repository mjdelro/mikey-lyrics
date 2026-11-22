import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const DBUS_NAME = 'org.freedesktop.DBus';
const DBUS_PATH = '/org/freedesktop/DBus';
const DBUS_IFACE = 'org.freedesktop.DBus';

const MPRIS_PREFIX = 'org.mpris.MediaPlayer2.';
const MPRIS_PATH = '/org/mpris/MediaPlayer2';
const MPRIS_PLAYER_IFACE = 'org.mpris.MediaPlayer2.Player';
const PROPS_IFACE = 'org.freedesktop.DBus.Properties';

function unpackMetadata(metaDict) {
    if (!metaDict) {
        return {
            title: '',
            artist: '',
            album: '',
            duration: 0,
            artUrl: '',
            trackId: '',
        };
    }

    const getStr = key => {
        const v = metaDict[key];
        if (!v)
            return '';
        const unpacked = v.deepUnpack ? v.deepUnpack() : v;
        if (Array.isArray(unpacked))
            return unpacked.filter(Boolean).join(', ');
        return typeof unpacked === 'string' ? unpacked : '';
    };

    const lenVariant = metaDict['mpris:length'];
    const lenMicros = lenVariant ? Number(lenVariant.deepUnpack ? lenVariant.deepUnpack() : lenVariant) : 0;

    return {
        title: getStr('xesam:title'),
        artist: getStr('xesam:artist') || getStr('xesam:albumArtist'),
        album: getStr('xesam:album'),
        duration: lenMicros > 0 ? lenMicros / 1_000_000 : 0,
        artUrl: getStr('mpris:artUrl'),
        trackId: getStr('mpris:trackid'),
    };
}

/**
 * Native MPRIS2 D-Bus controller for GNOME Shell.
 * Tracks all running MPRIS players, automatically selects the active one,
 * and exposes playback controls + interpolated position.
 */
export class MprisController {
    constructor(onChange) {
        this._onChange = onChange;
        this._bus = Gio.DBus.session;
        this._players = new Map(); // busName -> { status, metadata, position, posTimestamp }
        this._activeBusName = null;
        this._destroyed = false;

        this._nameOwnerSubId = this._bus.signal_subscribe(
            DBUS_NAME,
            DBUS_IFACE,
            'NameOwnerChanged',
            DBUS_PATH,
            null,
            Gio.DBusSignalFlags.NONE,
            (_conn, _sender, _path, _iface, _signal, params) => {
                const [name, oldOwner, newOwner] = params.deepUnpack();
                if (!name.startsWith(MPRIS_PREFIX))
                    return;
                if (newOwner && !oldOwner)
                    this._addPlayer(name);
                else if (!newOwner && oldOwner)
                    this._removePlayer(name);
            }
        );

        this._propsSubId = this._bus.signal_subscribe(
            null,
            PROPS_IFACE,
            'PropertiesChanged',
            MPRIS_PATH,
            MPRIS_PLAYER_IFACE,
            Gio.DBusSignalFlags.NONE,
            (_conn, sender, _path, _iface, _signal, params) => {
                const [_ifaceName, changed] = params.deepUnpack();
                this._handlePropertiesChanged(sender, changed);
            }
        );

        this._seekedSubId = this._bus.signal_subscribe(
            null,
            MPRIS_PLAYER_IFACE,
            'Seeked',
            MPRIS_PATH,
            null,
            Gio.DBusSignalFlags.NONE,
            (_conn, sender, _path, _iface, _signal, params) => {
                const [posMicros] = params.deepUnpack();
                const player = this._findPlayerBySender(sender);
                if (!player)
                    return;
                const posSec = Math.max(0, Number(posMicros) / 1_000_000);
                player.lastRawPos = posSec;
                player.position = posSec;
                player.posTimestamp = GLib.get_monotonic_time();
                if (player.busName === this._activeBusName)
                    this._emitChange(false);
            }
        );

        this._discoverPlayers();
    }

    _discoverPlayers() {
        this._bus.call(
            DBUS_NAME,
            DBUS_PATH,
            DBUS_IFACE,
            'ListNames',
            null,
            new GLib.VariantType('(as)'),
            Gio.DBusCallFlags.NONE,
            -1,
            null,
            (conn, res) => {
                if (this._destroyed)
                    return;
                try {
                    const [names] = conn.call_finish(res).deepUnpack();
                    for (const name of names) {
                        if (name.startsWith(MPRIS_PREFIX))
                            this._addPlayer(name);
                    }
                } catch (_e) {
                    // Ignore bus enumeration errors
                }
            }
        );
    }

    _addPlayer(busName) {
        if (this._players.has(busName))
            return;

        const entry = {
            busName,
            owner: null,
            status: 'Stopped',
            rate: 1.0,
            metadata: unpackMetadata(null),
            lastRawPos: -1,
            position: 0,
            posTimestamp: GLib.get_monotonic_time(),
        };
        this._players.set(busName, entry);

        // Resolve unique owner so PropertiesChanged sender matches reliably
        this._bus.call(
            DBUS_NAME,
            DBUS_PATH,
            DBUS_IFACE,
            'GetNameOwner',
            new GLib.Variant('(s)', [busName]),
            new GLib.VariantType('(s)'),
            Gio.DBusCallFlags.NONE,
            -1,
            null,
            (conn, res) => {
                if (this._destroyed || !this._players.has(busName))
                    return;
                try {
                    const [owner] = conn.call_finish(res).deepUnpack();
                    entry.owner = owner;
                } catch (_e) {
                    // Player may have exited
                }
            }
        );

        this._fetchPlayerProperties(busName);
    }

    _removePlayer(busName) {
        if (!this._players.delete(busName))
            return;
        if (this._activeBusName === busName) {
            this._activeBusName = null;
            this._selectBestPlayer();
            this._emitChange(true);
        }
    }

    _findPlayerBySender(sender) {
        for (const player of this._players.values()) {
            if (player.busName === sender || player.owner === sender)
                return player;
        }
        return null;
    }

    _fetchPlayerProperties(busName) {
        this._bus.call(
            busName,
            MPRIS_PATH,
            PROPS_IFACE,
            'GetAll',
            new GLib.Variant('(s)', [MPRIS_PLAYER_IFACE]),
            new GLib.VariantType('(a{sv})'),
            Gio.DBusCallFlags.NONE,
            -1,
            null,
            (conn, res) => {
                if (this._destroyed)
                    return;
                const player = this._players.get(busName);
                if (!player)
                    return;
                try {
                    const [props] = conn.call_finish(res).deepUnpack();
                    if (props.PlaybackStatus)
                        player.status = props.PlaybackStatus.deepUnpack();
                    if (props.Rate) {
                        const r = Number(props.Rate.deepUnpack());
                        if (r > 0)
                            player.rate = r;
                    }
                    if (props.Metadata)
                        player.metadata = unpackMetadata(props.Metadata.deepUnpack());
                    if (props.Position) {
                        const posSec = Math.max(0, Number(props.Position.deepUnpack()) / 1_000_000);
                        player.lastRawPos = posSec;
                        player.position = posSec;
                        player.posTimestamp = GLib.get_monotonic_time();
                    }
                    this._selectBestPlayer();
                    this._emitChange(true);
                } catch (_e) {
                    // Ignore transient D-Bus errors
                }
            }
        );
    }

    _handlePropertiesChanged(sender, changed) {
        const player = this._findPlayerBySender(sender);
        if (!player)
            return;

        let trackChanged = false;
        if (changed.PlaybackStatus) {
            player.status = changed.PlaybackStatus.deepUnpack();
            this.refreshPosition(player.busName, true);
        }
        if (changed.Rate) {
            const r = Number(changed.Rate.deepUnpack());
            if (r > 0)
                player.rate = r;
        }
        if (changed.Metadata) {
            const nextMeta = unpackMetadata(changed.Metadata.deepUnpack());
            if (nextMeta.title !== player.metadata.title ||
                nextMeta.artist !== player.metadata.artist ||
                nextMeta.album !== player.metadata.album) {
                trackChanged = true;
                player.lastRawPos = -1;
                player.position = 0;
                player.posTimestamp = GLib.get_monotonic_time();
            }
            player.metadata = nextMeta;
            this.refreshPosition(player.busName, true);
        }

        const prevActive = this._activeBusName;
        this._selectBestPlayer();
        if (this._activeBusName !== prevActive)
            trackChanged = true;

        if (player.busName === this._activeBusName || this._activeBusName !== prevActive)
            this._emitChange(trackChanged);
    }

    _selectBestPlayer() {
        const rank = status => {
            if (status === 'Playing')
                return 3;
            if (status === 'Paused')
                return 2;
            return 1;
        };

        let best = null;
        let bestRank = 0;

        // Keep current active player if it's still Playing
        if (this._activeBusName && this._players.has(this._activeBusName)) {
            const cur = this._players.get(this._activeBusName);
            if (cur.status === 'Playing')
                return;
        }

        for (const player of this._players.values()) {
            const r = rank(player.status);
            if (r > bestRank || (r === bestRank && player.metadata.title && !best?.metadata.title)) {
                bestRank = r;
                best = player;
            }
        }

        this._activeBusName = best ? best.busName : null;
    }

    refreshPosition(busName = this._activeBusName, forceSnap = false) {
        if (!busName || this._destroyed)
            return;
        const player = this._players.get(busName);
        if (!player)
            return;

        this._bus.call(
            busName,
            MPRIS_PATH,
            PROPS_IFACE,
            'Get',
            new GLib.Variant('(ss)', [MPRIS_PLAYER_IFACE, 'Position']),
            new GLib.VariantType('(v)'),
            Gio.DBusCallFlags.NONE,
            -1,
            null,
            (conn, res) => {
                if (this._destroyed || !this._players.has(busName))
                    return;
                try {
                    const [variant] = conn.call_finish(res).deepUnpack();
                    const posSec = Math.max(0, Number(variant.deepUnpack()) / 1_000_000);
                    const now = GLib.get_monotonic_time();

                    // Avoid snapping backwards when a player reports quantized/unchanged seconds while playing
                    if (!forceSnap && player.status === 'Playing' && posSec === player.lastRawPos)
                        return;

                    player.lastRawPos = posSec;
                    player.position = posSec;
                    player.posTimestamp = now;
                } catch (_e) {
                    // Some players do not expose Position
                }
            }
        );
    }

    getState() {
        const player = this._activeBusName ? this._players.get(this._activeBusName) : null;
        if (!player) {
            return {
                hasPlayer: false,
                status: 'Stopped',
                title: '',
                artist: '',
                album: '',
                duration: 0,
                artUrl: '',
                trackId: '',
                position: 0,
            };
        }

        let pos = player.position;
        if (player.status === 'Playing') {
            const elapsedSec = (GLib.get_monotonic_time() - player.posTimestamp) / 1_000_000;
            if (elapsedSec > 0)
                pos += elapsedSec * (player.rate || 1.0);
        }
        if (player.metadata.duration > 0)
            pos = Math.min(pos, player.metadata.duration);

        return {
            hasPlayer: true,
            status: player.status,
            ...player.metadata,
            position: Math.max(0, pos),
        };
    }

    _callMethod(method, params = null) {
        if (!this._activeBusName || this._destroyed)
            return;
        const targetBus = this._activeBusName;
        this._bus.call(
            targetBus,
            MPRIS_PATH,
            MPRIS_PLAYER_IFACE,
            method,
            params,
            null,
            Gio.DBusCallFlags.NONE,
            -1,
            null,
            (conn, res) => {
                try {
                    conn.call_finish(res);
                } catch (_e) {
                    // Ignore unsupported method errors
                }
            }
        );
    }

    playPause() {
        this._callMethod('PlayPause');
    }

    next() {
        this._callMethod('Next');
    }

    previous() {
        this._callMethod('Previous');
    }

    seekTo(targetSeconds) {
        const player = this._activeBusName ? this._players.get(this._activeBusName) : null;
        if (!player)
            return;
        const targetMicros = Math.floor(Math.max(0, targetSeconds) * 1_000_000);
        if (player.metadata.trackId && player.metadata.trackId.startsWith('/')) {
            this._callMethod(
                'SetPosition',
                new GLib.Variant('(ox)', [player.metadata.trackId, targetMicros])
            );
        } else {
            const cur = this.getState().position;
            const deltaMicros = Math.floor((targetSeconds - cur) * 1_000_000);
            this._callMethod('Seek', new GLib.Variant('(x)', [deltaMicros]));
        }
        player.position = Math.max(0, targetSeconds);
        player.posTimestamp = GLib.get_monotonic_time();
    }

    _emitChange(trackChanged) {
        if (!this._destroyed && this._onChange)
            this._onChange(this.getState(), trackChanged);
    }

    destroy() {
        this._destroyed = true;
        if (this._nameOwnerSubId) {
            this._bus.signal_unsubscribe(this._nameOwnerSubId);
            this._nameOwnerSubId = 0;
        }
        if (this._propsSubId) {
            this._bus.signal_unsubscribe(this._propsSubId);
            this._propsSubId = 0;
        }
        if (this._seekedSubId) {
            this._bus.signal_unsubscribe(this._seekedSubId);
            this._seekedSubId = 0;
        }
        this._players.clear();
        this._activeBusName = null;
    }
}
