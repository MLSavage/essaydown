// build.rs — tauri-build's Windows resource (icon, version info, app manifest) reaches bin targets
// only: tauri-winres -> embed-resource emits a bin-only rustc link-arg directive, and Cargo's
// `LinkArgTarget::Bin` applies to `target.is_bin()`, never to the lib's unit-test harness
// (`desktop_lib-*.exe`). Without the manifest the loader binds comctl32 v5 and the harness dies at
// load with STATUS_ENTRYPOINT_NOT_FOUND (rfd's and muda's `TaskDialogIndirect` are comctl32 v6
// imports; 2.verify.g1h a1, run 36300536766). On windows/msvc the manifest therefore comes from
// the linker for every linked target instead (`/MANIFEST:EMBED` + `/MANIFESTINPUT`, the route
// tauri-apps discussion #11179 gives), and tauri-build is told not to put it in the `.rc` as well,
// which would be a duplicate RT_MANIFEST resource. Other targets are unchanged: `try_build(
// Attributes::new())` is what `tauri_build::build()` calls.
fn main() {
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let target_env = std::env::var("CARGO_CFG_TARGET_ENV").unwrap_or_default();

    let mut attributes = tauri_build::Attributes::new();
    if target_os == "windows" && target_env == "msvc" {
        let manifest = std::path::Path::new(&std::env::var("CARGO_MANIFEST_DIR").unwrap())
            .join("windows-app-manifest.xml");
        println!("cargo:rerun-if-changed={}", manifest.display());
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
        attributes = attributes
            .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest());
    }

    if let Err(error) = tauri_build::try_build(attributes) {
        println!("{error:#}");
        std::process::exit(1);
    }
}
