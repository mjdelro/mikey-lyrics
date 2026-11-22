import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

function makeColorRow(settings, key, title, subtitle) {
    const row = new Adw.ActionRow({title, subtitle});
    const dialog = new Gtk.ColorDialog({with_alpha: true});
    const rgba = new Gdk.RGBA();
    if (!rgba.parse(settings.get_string(key)))
        rgba.parse('#ffffff');

    const btn = new Gtk.ColorDialogButton({
        dialog,
        rgba,
        valign: Gtk.Align.CENTER,
    });
    btn.connect('notify::rgba', () => {
        const c = btn.get_rgba();
        const r = Math.round(c.red * 255);
        const g = Math.round(c.green * 255);
        const b = Math.round(c.blue * 255);
        const a = Number(c.alpha.toFixed(2));
        settings.set_string(key, `rgba(${r},${g},${b},${a})`);
    });

    row.add_suffix(btn);
    row.activatable_widget = btn;
    return row;
}

export default class MikeyLyricsPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.set_title('mikey lyrics');

        const page = new Adw.PreferencesPage({
            title: 'mikey lyrics',
            icon_name: 'audio-x-generic-symbolic',
        });
        window.add(page);

        // === Synced Lyrics Group ===
        const syncGroup = new Adw.PreferencesGroup({
            title: 'Synchronous Lyrics',
            description: 'Configure LRCLIB time-synced lyrics display',
        });
        page.add(syncGroup);

        const syncRow = new Adw.SwitchRow({
            title: 'Enable Synced Lyrics',
            subtitle: 'Automatically sync lyrics to playback when available',
        });
        settings.bind('sync-enabled', syncRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        syncGroup.add(syncRow);

        const offsetRow = new Adw.SpinRow({
            title: 'Sync Offset (ms)',
            subtitle: 'Positive values advance lyrics; negative values delay them',
            adjustment: new Gtk.Adjustment({
                lower: -5000,
                upper: 5000,
                step_increment: 50,
                page_increment: 250,
            }),
        });
        settings.bind('sync-offset-ms', offsetRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        syncGroup.add(offsetRow);

        const ctxRow = new Adw.SpinRow({
            title: 'Context Lines',
            subtitle: 'Number of lines shown above and below the active lyric',
            adjustment: new Gtk.Adjustment({
                lower: 1,
                upper: 8,
                step_increment: 1,
            }),
        });
        settings.bind('sync-context-lines', ctxRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        syncGroup.add(ctxRow);

        // === Stylization Group ===
        const styleGroup = new Adw.PreferencesGroup({
            title: 'Stylization',
            description: 'Customize colors, typography, and surface styling',
        });
        page.add(styleGroup);

        const fontFamilyRow = new Adw.EntryRow({
            title: 'Font Family (leave blank for system default)',
        });
        settings.bind('font-family', fontFamilyRow, 'text', Gio.SettingsBindFlags.DEFAULT);
        styleGroup.add(fontFamilyRow);

        const fontRow = new Adw.SpinRow({
            title: 'Font Size (px)',
            adjustment: new Gtk.Adjustment({lower: 9, upper: 28, step_increment: 1}),
        });
        settings.bind('font-size', fontRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        styleGroup.add(fontRow);

        styleGroup.add(makeColorRow(
            settings,
            'accent-color',
            'Accent Color',
            'Progress bar fill color'
        ));
        styleGroup.add(makeColorRow(
            settings,
            'active-lyric-color',
            'Active Lyric Color',
            'Highlight color for the current synced line'
        ));
        styleGroup.add(makeColorRow(
            settings,
            'lyric-color',
            'Inactive / Plain Lyric Color',
            'Color for surrounding synced lines and plain lyrics'
        ));

        const opacityRow = new Adw.SpinRow({
            title: 'Background Opacity (0–255)',
            adjustment: new Gtk.Adjustment({lower: 0, upper: 255, step_increment: 5}),
        });
        settings.bind('background-opacity', opacityRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        styleGroup.add(opacityRow);

        const radiusRow = new Adw.SpinRow({
            title: 'Corner Radius (px)',
            adjustment: new Gtk.Adjustment({lower: 0, upper: 32, step_increment: 2}),
        });
        settings.bind('border-radius', radiusRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        styleGroup.add(radiusRow);

        // === Desktop Widget Layout Group ===
        const layoutGroup = new Adw.PreferencesGroup({
            title: 'Desktop Widget',
            description: 'Configure widget placement and behavior',
        });
        page.add(layoutGroup);

        const visibleRow = new Adw.SwitchRow({
            title: 'Show Desktop Widget',
        });
        settings.bind('widget-visible', visibleRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        layoutGroup.add(visibleRow);

        const vinylRow = new Adw.SwitchRow({
            title: 'Vinyl Record Mode',
            subtitle: 'Display album art as a spinning vinyl disc (or click the cover)',
        });
        settings.bind('vinyl-mode', vinylRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        layoutGroup.add(vinylRow);

        const lockRow = new Adw.SwitchRow({
            title: 'Lock Position',
            subtitle: 'Prevent accidental dragging on the desktop',
        });
        settings.bind('lock-position', lockRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        layoutGroup.add(lockRow);

        const onTopRow = new Adw.SwitchRow({
            title: 'Always on Top',
            subtitle: 'Float widget above normal windows instead of on the desktop layer',
        });
        settings.bind('always-on-top', onTopRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        layoutGroup.add(onTopRow);

        const panelRow = new Adw.SwitchRow({
            title: 'Show Top Bar Icon',
            subtitle: 'Quick toggle menu in the GNOME top panel',
        });
        settings.bind('show-panel-indicator', panelRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        layoutGroup.add(panelRow);

        const widthRow = new Adw.SpinRow({
            title: 'Widget Width (px)',
            adjustment: new Gtk.Adjustment({lower: 280, upper: 700, step_increment: 10}),
        });
        settings.bind('widget-width', widthRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        layoutGroup.add(widthRow);

        const heightRow = new Adw.SpinRow({
            title: 'Lyrics Area Height (px)',
            adjustment: new Gtk.Adjustment({lower: 180, upper: 800, step_increment: 10}),
        });
        settings.bind('lyrics-height', heightRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        layoutGroup.add(heightRow);
    }
}
