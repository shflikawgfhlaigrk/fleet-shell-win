mod probe;

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![probe::probe_surface])
        .run(tauri::generate_context!())
        .expect("failed to run BlackLabel fleet shell");
}
