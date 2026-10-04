//! The macOS menu bar (DECISIONS #review-2-r1 U2).
//!
//! `Builder::default()` installs tauri's default menu on macOS (tauri 2.11.5 `src/app.rs:2245-2247`),
//! whose Quit is the predefined quit item — muda maps it to `terminate:`, and tao 0.35.3 implements
//! no `applicationShouldTerminate:`, so Cmd+Q raised no CloseRequested and no exit-requested run
//! event, and edits inside the autosave debounce were lost. This module mirrors that default item for item
//! (`Menu::default`, tauri 2.11.5 `src/menu/menu.rs:142-239`, its macOS branch) except that Quit is a
//! custom item whose event closes every window, so each window's close barrier (App.tsx,
//! `decideClose`) flushes before it destroys and the app exits with its last window.
//!
//! Linux and Windows install no menu (as before); the spec and `build_menu` are compiled there only
//! for the test module, hence the `dead_code` allowances.

use tauri::menu::{
    AboutMetadata, Menu, MenuId, MenuItem, PredefinedMenuItem, Submenu, HELP_SUBMENU_ID,
    WINDOW_SUBMENU_ID,
};
use tauri::{AppHandle, Manager, Runtime};

/// The id of the custom Quit item that replaces the default's predefined quit item.
pub(crate) const QUIT_ID: &str = "quit";

/// One predefined item kind the installed default's macOS branch builds, less its Quit: the type has
/// no variant for the predefined quit item, so no spec can carry the `terminate:` route.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub(crate) enum PredefinedKind {
    About,
    Separator,
    Services,
    Hide,
    HideOthers,
    CloseWindow,
    Undo,
    Redo,
    Cut,
    Copy,
    Paste,
    SelectAll,
    Fullscreen,
    Minimize,
    Maximize,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ItemSpec {
    Predefined(PredefinedKind),
    Custom {
        id: &'static str,
        text: &'static str,
        accelerator: &'static str,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum SubmenuTitle {
    /// The package name, as the default's app submenu uses (`pkg_info.name`).
    AppName,
    Fixed(&'static str),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct SubmenuSpec {
    /// `WINDOW_SUBMENU_ID`/`HELP_SUBMENU_ID` where the default sets them (macOS reads them to make
    /// the Window and Help menus the system's), `None` where it lets muda pick one.
    pub id: Option<&'static str>,
    pub title: SubmenuTitle,
    pub items: Vec<ItemSpec>,
}

/// The default menu's macOS branch, with Quit replaced by the custom `quit` item at its position.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) fn default_menu_spec() -> Vec<SubmenuSpec> {
    use ItemSpec::Predefined as P;
    use PredefinedKind::*;
    vec![
        SubmenuSpec {
            id: None,
            title: SubmenuTitle::AppName,
            items: vec![
                P(About),
                P(Separator),
                P(Services),
                P(Separator),
                P(Hide),
                P(HideOthers),
                P(Separator),
                ItemSpec::Custom {
                    id: QUIT_ID,
                    text: "Quit Essay Down",
                    accelerator: "CmdOrCtrl+Q",
                },
            ],
        },
        SubmenuSpec {
            id: None,
            title: SubmenuTitle::Fixed("File"),
            items: vec![P(CloseWindow)],
        },
        SubmenuSpec {
            id: None,
            title: SubmenuTitle::Fixed("Edit"),
            items: vec![
                P(Undo),
                P(Redo),
                P(Separator),
                P(Cut),
                P(Copy),
                P(Paste),
                P(SelectAll),
            ],
        },
        SubmenuSpec {
            id: None,
            title: SubmenuTitle::Fixed("View"),
            items: vec![P(Fullscreen)],
        },
        SubmenuSpec {
            id: Some(WINDOW_SUBMENU_ID),
            title: SubmenuTitle::Fixed("Window"),
            items: vec![P(Minimize), P(Maximize), P(Separator), P(CloseWindow)],
        },
        SubmenuSpec {
            id: Some(HELP_SUBMENU_ID),
            title: SubmenuTitle::Fixed("Help"),
            items: vec![],
        },
    ]
}

/// Maps `spec` to `tauri::menu` items; the About metadata is built as the default builds it.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) fn build_menu<R: Runtime>(
    handle: &AppHandle<R>,
    spec: &[SubmenuSpec],
) -> tauri::Result<Menu<R>> {
    let pkg_info = handle.package_info();
    let config = handle.config();
    let about_metadata = AboutMetadata {
        name: Some(pkg_info.name.clone()),
        version: Some(pkg_info.version.to_string()),
        copyright: config.bundle.copyright.clone(),
        authors: config.bundle.publisher.clone().map(|p| vec![p]),
        ..Default::default()
    };

    let menu = Menu::new(handle)?;
    for submenu_spec in spec {
        let title = match submenu_spec.title {
            SubmenuTitle::AppName => pkg_info.name.clone(),
            SubmenuTitle::Fixed(text) => text.to_string(),
        };
        let submenu = match submenu_spec.id {
            Some(id) => Submenu::with_id(handle, id, title, true)?,
            None => Submenu::new(handle, title, true)?,
        };
        for item in &submenu_spec.items {
            match item {
                ItemSpec::Predefined(kind) => {
                    let h = handle;
                    let predefined = match kind {
                        PredefinedKind::About => {
                            PredefinedMenuItem::about(h, None, Some(about_metadata.clone()))?
                        }
                        PredefinedKind::Separator => PredefinedMenuItem::separator(h)?,
                        PredefinedKind::Services => PredefinedMenuItem::services(h, None)?,
                        PredefinedKind::Hide => PredefinedMenuItem::hide(h, None)?,
                        PredefinedKind::HideOthers => PredefinedMenuItem::hide_others(h, None)?,
                        PredefinedKind::CloseWindow => PredefinedMenuItem::close_window(h, None)?,
                        PredefinedKind::Undo => PredefinedMenuItem::undo(h, None)?,
                        PredefinedKind::Redo => PredefinedMenuItem::redo(h, None)?,
                        PredefinedKind::Cut => PredefinedMenuItem::cut(h, None)?,
                        PredefinedKind::Copy => PredefinedMenuItem::copy(h, None)?,
                        PredefinedKind::Paste => PredefinedMenuItem::paste(h, None)?,
                        PredefinedKind::SelectAll => PredefinedMenuItem::select_all(h, None)?,
                        PredefinedKind::Fullscreen => PredefinedMenuItem::fullscreen(h, None)?,
                        PredefinedKind::Minimize => PredefinedMenuItem::minimize(h, None)?,
                        PredefinedKind::Maximize => PredefinedMenuItem::maximize(h, None)?,
                    };
                    submenu.append(&predefined)?;
                }
                ItemSpec::Custom {
                    id,
                    text,
                    accelerator,
                } => {
                    let custom = MenuItem::with_id(handle, *id, *text, true, Some(*accelerator))?;
                    submenu.append(&custom)?;
                }
            }
        }
        menu.append(&submenu)?;
    }
    Ok(menu)
}

/// The menu-event dispatch: true only for the custom Quit item.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) fn quit_requested(id: &MenuId) -> bool {
    id.as_ref() == QUIT_ID
}

/// Asks every window to close, which raises CloseRequested so the frontend's close barrier flushes
/// the pending save and then destroys the window; the app exits with its last window. Returns the
/// labels whose `close()` failed — each is logged and that window stays open, so the app keeps
/// running rather than exiting as if every barrier had been reached.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) fn request_quit<R: Runtime>(app: &AppHandle<R>) -> Vec<String> {
    let mut failed = Vec::new();
    for (label, window) in app.webview_windows() {
        if let Err(error) = window.close() {
            eprintln!("quit: close() failed for window {label:?}: {error}");
            failed.push(label);
        }
    }
    failed
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use PredefinedKind::*;

    /// One item of the installed default: a kind this module can build, or the default's Quit.
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    enum DefaultItem {
        K(PredefinedKind),
        Quit,
    }
    use DefaultItem::{Quit, K};

    /// The installed default's macOS branch, typed from tauri 2.11.5 `src/menu/menu.rs:142-239`
    /// (the `cfg(target_os = "macos")` arms kept, the `not(macos)` arms dropped), one row per
    /// submenu in order: app submenu 186-194, File 208-212, Edit 218-224, View 230, Window
    /// 159-163, Help 172-175 (empty on macOS).
    const MACOS_DEFAULT: &[&[DefaultItem]] = &[
        &[
            K(About),
            K(Separator),
            K(Services),
            K(Separator),
            K(Hide),
            K(HideOthers),
            K(Separator),
            Quit,
        ],
        &[K(CloseWindow)],
        &[
            K(Undo),
            K(Redo),
            K(Separator),
            K(Cut),
            K(Copy),
            K(Paste),
            K(SelectAll),
        ],
        &[K(Fullscreen)],
        &[K(Minimize), K(Maximize), K(Separator), K(CloseWindow)],
        &[],
    ];

    fn default_quit_position() -> usize {
        MACOS_DEFAULT[0]
            .iter()
            .position(|item| *item == Quit)
            .unwrap()
    }

    fn kind_counts(
        kinds: impl IntoIterator<Item = PredefinedKind>,
    ) -> BTreeMap<PredefinedKind, usize> {
        let mut counts = BTreeMap::new();
        for kind in kinds {
            *counts.entry(kind).or_insert(0) += 1;
        }
        counts
    }

    fn spec_predefined(spec: &[SubmenuSpec]) -> Vec<PredefinedKind> {
        spec.iter()
            .flat_map(|s| s.items.iter())
            .filter_map(|item| match item {
                ItemSpec::Predefined(kind) => Some(*kind),
                ItemSpec::Custom { .. } => None,
            })
            .collect()
    }

    /// Every predefined kind of the default (Quit excepted) is present in `spec` exactly as often
    /// as the default carries it.
    fn matches_default_kinds(spec: &[SubmenuSpec]) -> bool {
        let expected = kind_counts(MACOS_DEFAULT.iter().flat_map(|s| s.iter()).filter_map(
            |item| match item {
                K(kind) => Some(*kind),
                Quit => None,
            },
        ));
        kind_counts(spec_predefined(spec)) == expected
    }

    fn customs(spec: &[SubmenuSpec]) -> Vec<(usize, usize, &ItemSpec)> {
        spec.iter()
            .enumerate()
            .flat_map(|(s, sub)| {
                sub.items
                    .iter()
                    .enumerate()
                    .map(move |(i, item)| (s, i, item))
            })
            .filter(|(_, _, item)| matches!(item, ItemSpec::Custom { .. }))
            .collect()
    }

    /// `PredefinedKind` has no Quit variant (so no spec can hold `Predefined(Quit)` and `build_menu`
    /// cannot call the predefined quit constructor); what the type cannot say is that the default's
    /// Quit slot was not just dropped, so this asserts the slot holds no predefined item.
    #[test]
    fn guard1_default_menu_spec_has_no_predefined_quit() {
        let spec = default_menu_spec();
        assert!(!matches!(
            spec[0].items[default_quit_position()],
            ItemSpec::Predefined(_)
        ));
    }

    #[test]
    fn guard2_one_custom_quit_item_at_the_default_quit_position() {
        let spec = default_menu_spec();
        let customs = customs(&spec);
        assert_eq!(customs.len(), 1, "exactly one custom item");
        let (submenu, index, item) = customs[0];
        assert_eq!(
            (submenu, index),
            (0, default_quit_position()),
            "the first submenu, at the default's Quit position"
        );
        assert_eq!(spec[0].title, SubmenuTitle::AppName);
        assert_eq!(
            item,
            &ItemSpec::Custom {
                id: "quit",
                text: "Quit Essay Down",
                accelerator: "CmdOrCtrl+Q"
            }
        );
    }

    #[test]
    fn guard3_every_default_predefined_kind_present_with_its_multiplicity() {
        let spec = default_menu_spec();
        assert!(matches_default_kinds(&spec));
        // The shape matches too: same submenu count, each submenu the default's row with Quit
        // swapped for the custom item.
        assert_eq!(spec.len(), MACOS_DEFAULT.len());
        for (sub, row) in spec.iter().zip(MACOS_DEFAULT) {
            let kinds: Vec<Option<PredefinedKind>> = sub
                .items
                .iter()
                .map(|item| match item {
                    ItemSpec::Predefined(kind) => Some(*kind),
                    ItemSpec::Custom { .. } => None,
                })
                .collect();
            let expected: Vec<Option<PredefinedKind>> = row
                .iter()
                .map(|item| match item {
                    K(kind) => Some(*kind),
                    Quit => None,
                })
                .collect();
            assert_eq!(kinds, expected, "submenu {:?}", sub.title);
        }
        assert_eq!(spec[4].id, Some(WINDOW_SUBMENU_ID));
        assert_eq!(spec[5].id, Some(HELP_SUBMENU_ID));
    }

    #[test]
    fn guard3_absence_case_a_spec_missing_paste_fails_the_comparison() {
        let mut spec = default_menu_spec();
        let edit = &mut spec[2].items;
        edit.retain(|item| item != &ItemSpec::Predefined(Paste));
        assert!(!matches_default_kinds(&spec));
    }

    #[test]
    fn guard4_quit_requested_only_for_the_quit_id() {
        assert!(quit_requested(&MenuId::new("quit")));
        for other in [
            "",
            "Quit",
            "quit ",
            "close",
            "__tauri_window_menu__",
            "about",
        ] {
            assert!(!quit_requested(&MenuId::new(other)), "{other:?}");
        }
    }

    /// Off macOS only: `build_menu` calls `Menu::new`, which runs `muda::Menu::new()` inline on the
    /// calling thread under `MockRuntime` (tauri-2.11.5 `src/test/mock_runtime.rs:76-91`, the app
    /// not yet running), and only muda's macOS `platform_impl` asserts that thread is the main one
    /// (`src/platform_impl/macos/mod.rs:132`) — libtest runs every `#[test]` on a worker thread, so
    /// this guard panics there. Proving `build_menu` on macOS itself needs `harness = false` (a
    /// manifest change out of this task's scope); on macOS it is proven only by the production run
    /// at human gate 2.25 (its checks (2) and (4)).
    #[cfg(not(target_os = "macos"))]
    #[test]
    fn guard5_build_menu_under_mock_runtime_matches_the_spec_per_submenu() {
        let app = tauri::test::mock_builder()
            .build(crate::context())
            .expect("failed to build mock app");
        let spec = default_menu_spec();
        let menu = build_menu(app.handle(), &spec).expect("build_menu under MockRuntime");
        let items = menu.items().unwrap();
        assert_eq!(items.len(), spec.len());
        for (item, sub_spec) in items.iter().zip(&spec) {
            let submenu = item
                .as_submenu()
                .expect("every top-level item is a submenu");
            assert_eq!(
                submenu.items().unwrap().len(),
                sub_spec.items.len(),
                "{:?}",
                sub_spec.title
            );
        }
        let app_menu = items[0].as_submenu().unwrap().items().unwrap();
        let quit = &app_menu[default_quit_position()];
        assert!(quit_requested(quit.id()));
        assert_eq!(items[4].id().as_ref(), WINDOW_SUBMENU_ID);
        assert_eq!(items[5].id().as_ref(), HELP_SUBMENU_ID);
    }

    #[test]
    fn request_quit_closes_every_window_and_reports_no_failure() {
        let app = tauri::test::mock_builder()
            .build(crate::context())
            .expect("failed to build mock app");
        for label in ["main", "second"] {
            tauri::WebviewWindowBuilder::new(&app, label, Default::default())
                .build()
                .expect("failed to build test webview");
        }
        assert_eq!(app.webview_windows().len(), 2);
        assert!(request_quit(app.handle()).is_empty());
    }
}
