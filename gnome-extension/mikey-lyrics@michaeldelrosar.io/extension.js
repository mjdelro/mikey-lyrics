import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import Soup from 'gi://Soup?version=3.0';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {
    fetchLyrics,
    findActiveLineIndex,
    formatTime,
} from './lyricsEngine.js';
import {MprisController} from './mprisController.js';

function makeVBox(props = {}) {
    const box = new St.BoxLayout(props);
    box.layout_manager.orientation = Clutter.Orientation.VERTICAL;
    return box;
}

export default class MikeyLyricsExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._soupSession = new Soup.Session();
        this._fetchCancellable = null;
        this._artCancellable = null;
        this._debounceTimerId = 0;
        this._tickTimerId = 0;
        this._posSyncCounter = 0;

        this._lastTrackKey = '';
        this._lastArtUrl = '';
        this._lyricsData = {
            found: false,
            hasSynced: false,
            syncedLines: [],
            plainLyrics: '',
            isInstrumental: false,
        };
        this._activeLineIndex = -2;
        this._dragging = false;
        this._dragStartX = 0;
        this._dragStartY = 0;
        this._widgetStartX = 0;
        this._widgetStartY = 0;
        this._stageCaptureId = 0;

        this._buildWidget();
        this._attachWidgetToLayer();
        this._applyVisualSettings();
        this._applyPosition();
        this._setupPanelIndicator();

        this._mpris = new MprisController((state, trackChanged) => {
            this._onMediaUpdate(state, trackChanged);
        });

        this._settingsChangedId = this._settings.connect('changed', (_s, key) => {
            this._onSettingChanged(key);
        });

        Main.layoutManager.connectObject(
            'monitors-changed',
            () => this._applyPosition(),
            this
        );

        // 200ms sync loop (5 Hz) for snappy synchronous lyrics + progress bar
        this._tickTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
            this._onTick();
            return GLib.SOURCE_CONTINUE;
        });

        this._onMediaUpdate(this._mpris.getState(), true);
    }

    disable() {
        Main.layoutManager.disconnectObject(this);

        if (this._tickTimerId) {
            GLib.source_remove(this._tickTimerId);
            this._tickTimerId = 0;
        }
        if (this._debounceTimerId) {
            GLib.source_remove(this._debounceTimerId);
            this._debounceTimerId = 0;
        }
        if (this._fetchCancellable) {
            this._fetchCancellable.cancel();
            this._fetchCancellable = null;
        }
        if (this._artCancellable) {
            this._artCancellable.cancel();
            this._artCancellable = null;
        }
        this._stopDrag();

        if (this._settingsChangedId && this._settings) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = 0;
        }
        if (this._mpris) {
            this._mpris.destroy();
            this._mpris = null;
        }
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
        if (this._root) {
            this._detachWidgetFromLayer();
            this._root.destroy();
            this._root = null;
        }
        if (this._soupSession) {
            this._soupSession.abort();
            this._soupSession = null;
        }
        this._settings = null;
    }

    _buildWidget() {
        this._root = makeVBox({
            style_class: 'mikey-lyrics-root',
            reactive: true,
            can_focus: true,
            track_hover: true,
        });

        // Allow dragging from root background or toolbar
        this._root.connect('button-press-event', (_actor, event) => {
            if (event.get_button() !== 1 || this._settings.get_boolean('lock-position'))
                return Clutter.EVENT_PROPAGATE;
            this._startDrag(event);
            return Clutter.EVENT_STOP;
        });

        // === Top toolbar (Sync toggle, spacer, Font -, Font +) ===
        const toolbar = new St.BoxLayout({
            style_class: 'mikey-lyrics-toolbar',
            x_expand: true,
        });

        this._syncBtn = new St.Button({
            style_class: 'mikey-lyrics-icon-btn',
            child: new St.Icon({
                icon_name: 'media-playlist-repeat-symbolic',
                icon_size: 16,
            }),
            reactive: true,
            can_focus: true,
            visible: false,
        });
        this._syncBtn.connect('clicked', () => {
            const cur = this._settings.get_boolean('sync-enabled');
            this._settings.set_boolean('sync-enabled', !cur);
        });

        const spacer = new St.Widget({x_expand: true});

        const fontDownBtn = new St.Button({
            style_class: 'mikey-lyrics-icon-btn',
            child: new St.Icon({icon_name: 'zoom-out-symbolic', icon_size: 15}),
            reactive: true,
            can_focus: true,
        });
        fontDownBtn.connect('clicked', () => this._adjustFontSize(-1));

        const fontUpBtn = new St.Button({
            style_class: 'mikey-lyrics-icon-btn',
            child: new St.Icon({icon_name: 'zoom-in-symbolic', icon_size: 15}),
            reactive: true,
            can_focus: true,
        });
        fontUpBtn.connect('clicked', () => this._adjustFontSize(1));

        toolbar.add_child(this._syncBtn);
        toolbar.add_child(spacer);
        toolbar.add_child(fontDownBtn);
        toolbar.add_child(fontUpBtn);
        this._root.add_child(toolbar);

        // === Lyrics container ===
        this._lyricsArea = makeVBox({
            style_class: 'mikey-lyrics-area',
            x_expand: true,
            y_expand: true,
            clip_to_allocation: true,
        });

        // Plain scrollable lyrics view
        this._plainScroll = new St.ScrollView({
            style_class: 'mikey-lyrics-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            x_expand: true,
            y_expand: true,
        });
        const plainInner = makeVBox({x_expand: true});
        this._plainLabel = new St.Label({
            style_class: 'mikey-lyrics-plain',
            text: 'No track playing.',
            x_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._plainLabel.clutter_text.line_wrap = true;
        this._plainLabel.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        this._plainLabel.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        this._plainLabel.clutter_text.line_alignment = Pango.Alignment.CENTER;
        plainInner.add_child(this._plainLabel);
        this._plainScroll.set_child(plainInner);

        // Synced 3-tier lyrics view (Prev / Current / Next)
        this._syncedBox = makeVBox({
            style_class: 'mikey-lyrics-synced-box',
            x_expand: true,
            y_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });

        const makeSyncedLabel = styleClass => {
            const lbl = new St.Label({
                style_class: styleClass,
                text: '',
                x_expand: true,
                x_align: Clutter.ActorAlign.CENTER,
            });
            lbl.clutter_text.line_wrap = true;
            lbl.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
            lbl.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
            lbl.clutter_text.line_alignment = Pango.Alignment.CENTER;
            return lbl;
        };

        this._prevLabel = makeSyncedLabel('mikey-lyrics-prev');
        this._currentLabel = makeSyncedLabel('mikey-lyrics-current');
        this._nextLabel = makeSyncedLabel('mikey-lyrics-next');

        this._syncedBox.add_child(this._prevLabel);
        this._syncedBox.add_child(this._currentLabel);
        this._syncedBox.add_child(this._nextLabel);

        this._lyricsArea.add_child(this._plainScroll);
        this._lyricsArea.add_child(this._syncedBox);
        this._root.add_child(this._lyricsArea);

        // === Divider ===
        this._root.add_child(new St.Widget({style_class: 'mikey-lyrics-divider', x_expand: true}));

        // === Player panel ===
        const playerBox = makeVBox({
            style_class: 'mikey-lyrics-player',
            x_expand: true,
        });

        const infoRow = new St.BoxLayout({x_expand: true});

        const coverFrame = new St.Bin({
            style_class: 'mikey-lyrics-cover-frame',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._coverIcon = new St.Icon({
            icon_name: 'audio-x-generic-symbolic',
            icon_size: 48,
        });
        coverFrame.set_child(this._coverIcon);

        const metaCol = makeVBox({
            style_class: 'mikey-lyrics-meta',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._titleLabel = new St.Label({
            style_class: 'mikey-lyrics-title',
            text: 'Not Playing',
            x_expand: true,
        });
        this._titleLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;

        const artistRow = new St.BoxLayout({
            style_class: 'mikey-lyrics-subrow',
            y_align: Clutter.ActorAlign.CENTER,
        });
        artistRow.add_child(new St.Icon({icon_name: 'avatar-default-symbolic', icon_size: 14}));
        this._artistLabel = new St.Label({text: '—', x_expand: true});
        this._artistLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        artistRow.add_child(this._artistLabel);

        const albumRow = new St.BoxLayout({
            style_class: 'mikey-lyrics-subrow',
            y_align: Clutter.ActorAlign.CENTER,
        });
        albumRow.add_child(new St.Icon({icon_name: 'media-optical-symbolic', icon_size: 14}));
        this._albumLabel = new St.Label({text: '—', x_expand: true});
        this._albumLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        albumRow.add_child(this._albumLabel);

        // Controls + Time row
        const controlsRow = new St.BoxLayout({
            style_class: 'mikey-lyrics-controls-row',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        const prevBtn = new St.Button({
            style_class: 'mikey-lyrics-media-btn',
            child: new St.Icon({icon_name: 'media-skip-backward-symbolic', icon_size: 18}),
            reactive: true,
            can_focus: true,
        });
        prevBtn.connect('clicked', () => this._mpris?.previous());

        this._playPauseIcon = new St.Icon({
            icon_name: 'media-playback-start-symbolic',
            icon_size: 20,
        });
        const playPauseBtn = new St.Button({
            style_class: 'mikey-lyrics-media-btn',
            child: this._playPauseIcon,
            reactive: true,
            can_focus: true,
        });
        playPauseBtn.connect('clicked', () => this._mpris?.playPause());

        const nextBtn = new St.Button({
            style_class: 'mikey-lyrics-media-btn',
            child: new St.Icon({icon_name: 'media-skip-forward-symbolic', icon_size: 18}),
            reactive: true,
            can_focus: true,
        });
        nextBtn.connect('clicked', () => this._mpris?.next());

        const ctrlSpacer = new St.Widget({x_expand: true});
        this._timeLabel = new St.Label({
            style_class: 'mikey-lyrics-time',
            text: '0:00 / 0:00',
            y_align: Clutter.ActorAlign.CENTER,
        });

        controlsRow.add_child(prevBtn);
        controlsRow.add_child(playPauseBtn);
        controlsRow.add_child(nextBtn);
        controlsRow.add_child(ctrlSpacer);
        controlsRow.add_child(this._timeLabel);

        metaCol.add_child(this._titleLabel);
        metaCol.add_child(artistRow);
        metaCol.add_child(albumRow);
        metaCol.add_child(controlsRow);

        infoRow.add_child(coverFrame);
        infoRow.add_child(metaCol);

        // Seekable progress bar
        this._progressTrack = new St.Widget({
            style_class: 'mikey-lyrics-progress-track',
            x_expand: true,
            reactive: true,
        });
        this._progressFill = new St.Widget({
            style_class: 'mikey-lyrics-progress-fill',
            width: 0,
        });
        this._progressTrack.add_child(this._progressFill);
        this._progressTrack.connect('button-press-event', (_actor, event) => {
            if (event.get_button() !== 1)
                return Clutter.EVENT_PROPAGATE;
            const state = this._mpris?.getState();
            if (!state || state.duration <= 0)
                return Clutter.EVENT_STOP;
            const [stageX] = event.get_coords();
            const [trackX] = this._progressTrack.get_transformed_position();
            const trackW = this._progressTrack.width;
            if (trackW > 0) {
                const ratio = Math.max(0, Math.min(1, (stageX - trackX) / trackW));
                this._mpris.seekTo(ratio * state.duration);
                this._onTick();
            }
            return Clutter.EVENT_STOP;
        });

        playerBox.add_child(infoRow);
        playerBox.add_child(this._progressTrack);
        this._root.add_child(playerBox);
    }

    _attachWidgetToLayer() {
        if (!this._root)
            return;
        this._detachWidgetFromLayer();
        if (this._settings.get_boolean('always-on-top'))
            Main.layoutManager.addTopChrome(this._root, {trackFullscreen: false});
        else
            Main.layoutManager._backgroundGroup.add_child(this._root);
        this._root.visible = this._settings.get_boolean('widget-visible');
    }

    _detachWidgetFromLayer() {
        if (!this._root)
            return;
        const parent = this._root.get_parent();
        if (!parent)
            return;
        if (parent === Main.layoutManager.uiGroup)
            Main.layoutManager.removeChrome(this._root);
        else
            parent.remove_child(this._root);
    }

    _setupPanelIndicator() {
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
        if (!this._settings.get_boolean('show-panel-indicator'))
            return;

        this._indicator = new PanelMenu.Button(0.0, 'Mikey Lyrics', false);
        this._indicator.add_child(new St.Icon({
            icon_name: 'audio-x-generic-symbolic',
            style_class: 'system-status-icon',
        }));

        const visibleItem = new PopupMenu.PopupSwitchMenuItem(
            'Show Desktop Widget',
            this._settings.get_boolean('widget-visible')
        );
        visibleItem.connect('toggled', (_item, state) => {
            this._settings.set_boolean('widget-visible', state);
        });

        const syncItem = new PopupMenu.PopupSwitchMenuItem(
            'Synced Lyrics',
            this._settings.get_boolean('sync-enabled')
        );
        syncItem.connect('toggled', (_item, state) => {
            this._settings.set_boolean('sync-enabled', state);
        });

        const lockItem = new PopupMenu.PopupSwitchMenuItem(
            'Lock Position',
            this._settings.get_boolean('lock-position')
        );
        lockItem.connect('toggled', (_item, state) => {
            this._settings.set_boolean('lock-position', state);
        });

        const onTopItem = new PopupMenu.PopupSwitchMenuItem(
            'Always on Top',
            this._settings.get_boolean('always-on-top')
        );
        onTopItem.connect('toggled', (_item, state) => {
            this._settings.set_boolean('always-on-top', state);
        });

        const prefsItem = new PopupMenu.PopupMenuItem('Preferences');
        prefsItem.connect('activate', () => this.openPreferences());

        this._indicator.menu.addMenuItem(visibleItem);
        this._indicator.menu.addMenuItem(syncItem);
        this._indicator.menu.addMenuItem(lockItem);
        this._indicator.menu.addMenuItem(onTopItem);
        this._indicator.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._indicator.menu.addMenuItem(prefsItem);

        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    _applyVisualSettings() {
        if (!this._root)
            return;
        const width = this._settings.get_int('widget-width');
        const lyricsHeight = this._settings.get_int('lyrics-height');
        const opacity = this._settings.get_int('background-opacity');
        const alpha = (Math.max(0, Math.min(255, opacity)) / 255).toFixed(3);
        const accent = this._settings.get_string('accent-color') || '#1e824c';
        const fontSize = this._settings.get_int('font-size');

        this._root.width = width;
        this._root.set_style(`background-color: rgba(0, 0, 0, ${alpha});`);
        this._lyricsArea.height = lyricsHeight;
        this._progressFill.set_style(`background-color: ${accent};`);

        this._plainLabel.set_style(`font-size: ${fontSize}px;`);
        this._prevLabel.set_style(`font-size: ${fontSize}px;`);
        this._nextLabel.set_style(`font-size: ${fontSize}px;`);
        this._currentLabel.set_style(`font-size: ${fontSize + 3}px;`);

        this._updateSyncButtonStyle();
    }

    _applyPosition() {
        if (!this._root)
            return;
        const monitor = Main.layoutManager.primaryMonitor;
        let x = this._settings.get_int('pos-x');
        let y = this._settings.get_int('pos-y');
        if (monitor) {
            const maxX = monitor.x + Math.max(0, monitor.width - this._root.width);
            const maxY = monitor.y + Math.max(0, monitor.height - 120);
            x = Math.max(monitor.x, Math.min(x, maxX));
            y = Math.max(monitor.y, Math.min(y, maxY));
        }
        this._root.set_position(x, y);
    }

    _startDrag(event) {
        this._dragging = true;
        const [sx, sy] = event.get_coords();
        this._dragStartX = sx;
        this._dragStartY = sy;
        this._widgetStartX = this._root.x;
        this._widgetStartY = this._root.y;

        this._stageCaptureId = global.stage.connect('captured-event', (_stage, ev) => {
            const type = ev.type();
            if (type === Clutter.EventType.MOTION) {
                const [mx, my] = ev.get_coords();
                this._root.set_position(
                    Math.round(this._widgetStartX + (mx - this._dragStartX)),
                    Math.round(this._widgetStartY + (my - this._dragStartY))
                );
                return Clutter.EVENT_STOP;
            }
            if (type === Clutter.EventType.BUTTON_RELEASE) {
                this._settings.set_int('pos-x', Math.round(this._root.x));
                this._settings.set_int('pos-y', Math.round(this._root.y));
                this._stopDrag();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
    }

    _stopDrag() {
        this._dragging = false;
        if (this._stageCaptureId) {
            global.stage.disconnect(this._stageCaptureId);
            this._stageCaptureId = 0;
        }
    }

    _adjustFontSize(delta) {
        const cur = this._settings.get_int('font-size');
        const next = Math.max(9, Math.min(28, cur + delta));
        if (next !== cur)
            this._settings.set_int('font-size', next);
    }

    _onSettingChanged(key) {
        switch (key) {
        case 'widget-width':
        case 'lyrics-height':
        case 'background-opacity':
        case 'accent-color':
        case 'font-size':
            this._applyVisualSettings();
            break;
        case 'pos-x':
        case 'pos-y':
            if (!this._dragging)
                this._applyPosition();
            break;
        case 'always-on-top':
            this._attachWidgetToLayer();
            break;
        case 'widget-visible':
            if (this._root)
                this._root.visible = this._settings.get_boolean('widget-visible');
            break;
        case 'show-panel-indicator':
            this._setupPanelIndicator();
            break;
        case 'sync-enabled':
        case 'sync-offset-ms':
        case 'sync-context-lines':
            this._activeLineIndex = -2;
            this._renderLyricsMode();
            break;
        }
    }

    _onMediaUpdate(state, trackChanged) {
        this._titleLabel.text = state.title || 'Not Playing';
        this._artistLabel.text = state.artist || '—';
        this._albumLabel.text = state.album || '—';
        this._playPauseIcon.icon_name = state.status === 'Playing'
            ? 'media-playback-pause-symbolic'
            : 'media-playback-start-symbolic';

        this._updateCoverArt(state.artUrl);
        this._updateProgressUI(state);

        const trackKey = `${state.title}|${state.artist}|${state.album}|${Math.round(state.duration || 0)}`;
        if (trackChanged || trackKey !== this._lastTrackKey) {
            this._lastTrackKey = trackKey;
            this._scheduleLyricsFetch(state);
        }
    }

    _scheduleLyricsFetch(state) {
        if (this._debounceTimerId) {
            GLib.source_remove(this._debounceTimerId);
            this._debounceTimerId = 0;
        }
        if (this._fetchCancellable) {
            this._fetchCancellable.cancel();
            this._fetchCancellable = null;
        }

        if (!state.title) {
            this._lyricsData = {found: false, hasSynced: false, syncedLines: [], plainLyrics: '', isInstrumental: false};
            this._showPlainText('No track playing.');
            this._syncBtn.visible = false;
            return;
        }

        this._showPlainText('Loading lyrics...');
        this._syncBtn.visible = false;

        this._debounceTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 350, () => {
            this._debounceTimerId = 0;
            const cancellable = new Gio.Cancellable();
            this._fetchCancellable = cancellable;

            fetchLyrics(this._soupSession, state, cancellable)
                .then(result => {
                    if (cancellable.is_cancelled() || !this._root)
                        return;
                    this._lyricsData = result;
                    this._activeLineIndex = -2;
                    this._renderLyricsMode();
                })
                .catch(err => {
                    if (!err?.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED) && this._root)
                        this._showPlainText('No lyrics found.');
                });
            return GLib.SOURCE_REMOVE;
        });
    }

    _updateSyncButtonStyle() {
        const enabled = this._settings.get_boolean('sync-enabled');
        if (enabled)
            this._syncBtn.add_style_class_name('mikey-lyrics-icon-btn-active');
        else
            this._syncBtn.remove_style_class_name('mikey-lyrics-icon-btn-active');
    }

    _showPlainText(text) {
        this._syncedBox.visible = false;
        this._plainScroll.visible = true;
        this._plainLabel.text = text;
        const vadj = this._plainScroll.vadjustment ?? this._plainScroll.get_vscroll_bar()?.adjustment;
        if (vadj)
            vadj.value = 0;
    }

    _renderLyricsMode() {
        const data = this._lyricsData;
        this._syncBtn.visible = data.hasSynced;
        this._updateSyncButtonStyle();

        if (data.isInstrumental) {
            this._showPlainText('♪ Instrumental ♪');
            return;
        }

        if (data.hasSynced && this._settings.get_boolean('sync-enabled')) {
            this._plainScroll.visible = false;
            this._syncedBox.visible = true;
            this._updateSyncedLines(this._mpris?.getState()?.position ?? 0);
        } else if (data.plainLyrics) {
            this._showPlainText(data.plainLyrics);
        } else {
            this._showPlainText('No lyrics found.');
        }
    }

    _updateSyncedLines(posSec) {
        const lines = this._lyricsData.syncedLines;
        if (!lines.length)
            return;
        const offsetSec = this._settings.get_int('sync-offset-ms') / 1000.0;
        const idx = findActiveLineIndex(lines, posSec + offsetSec);
        if (idx === this._activeLineIndex)
            return;
        this._activeLineIndex = idx;

        const ctx = this._settings.get_int('sync-context-lines');
        const prevParts = [];
        for (let i = Math.max(0, idx - ctx); i < idx; i++)
            prevParts.push(lines[i].text || '• • •');

        let currentText = '♪';
        if (idx >= 0 && idx < lines.length)
            currentText = lines[idx].text || '• • •';

        const nextParts = [];
        const startNext = Math.max(0, idx + 1);
        for (let i = startNext; i < Math.min(lines.length, startNext + ctx); i++)
            nextParts.push(lines[i].text || '• • •');

        this._prevLabel.text = prevParts.join('\n');
        this._currentLabel.text = currentText;
        this._nextLabel.text = nextParts.join('\n');
    }

    _updateProgressUI(state) {
        this._timeLabel.text = `${formatTime(state.position)} / ${formatTime(state.duration)}`;
        const trackW = this._progressTrack.width;
        if (trackW > 0 && state.duration > 0) {
            const ratio = Math.max(0, Math.min(1, state.position / state.duration));
            this._progressFill.width = Math.round(trackW * ratio);
        } else {
            this._progressFill.width = 0;
        }
    }

    _updateCoverArt(artUrl) {
        if (artUrl === this._lastArtUrl)
            return;
        this._lastArtUrl = artUrl;

        if (this._artCancellable) {
            this._artCancellable.cancel();
            this._artCancellable = null;
        }

        const resetFallback = () => {
            this._coverIcon.gicon = null;
            this._coverIcon.icon_name = 'audio-x-generic-symbolic';
            this._coverIcon.icon_size = 48;
        };

        if (!artUrl) {
            resetFallback();
            return;
        }

        if (artUrl.startsWith('file://')) {
            try {
                const file = Gio.File.new_for_uri(artUrl);
                this._coverIcon.gicon = new Gio.FileIcon({file});
                this._coverIcon.icon_size = 92;
            } catch (_e) {
                resetFallback();
            }
            return;
        }

        if (artUrl.startsWith('http://') || artUrl.startsWith('https://')) {
            const cancellable = new Gio.Cancellable();
            this._artCancellable = cancellable;
            const message = Soup.Message.new('GET', artUrl);
            this._soupSession.send_and_read_async(message, GLib.PRIORITY_LOW, cancellable, (sess, res) => {
                try {
                    const bytes = sess.send_and_read_finish(res);
                    if (cancellable.is_cancelled() || !this._coverIcon)
                        return;
                    if (message.get_status() === Soup.Status.OK && bytes) {
                        this._coverIcon.gicon = Gio.BytesIcon.new(bytes);
                        this._coverIcon.icon_size = 92;
                    } else {
                        resetFallback();
                    }
                } catch (_e) {
                    if (!cancellable.is_cancelled() && this._coverIcon)
                        resetFallback();
                }
            });
            return;
        }

        resetFallback();
    }

    _onTick() {
        if (!this._mpris || !this._root || !this._root.visible)
            return;

        const state = this._mpris.getState();
        if (!state.hasPlayer)
            return;

        // Periodically resync authoritative position from player every ~2s while playing
        if (state.status === 'Playing') {
            this._posSyncCounter = (this._posSyncCounter + 1) % 10;
            if (this._posSyncCounter === 0)
                this._mpris.refreshPosition();
        }

        this._updateProgressUI(state);
        if (this._lyricsData.hasSynced && this._settings.get_boolean('sync-enabled'))
            this._updateSyncedLines(state.position);
    }
}
