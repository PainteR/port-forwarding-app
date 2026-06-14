use tauri::AppHandle;

use crate::models::{ForwardRuntimeStatus, RuntimeState};

pub fn clear_active_forward_badge(app: &AppHandle) {
    set_active_forward_badge(app, 0);
}

pub fn update_active_forward_badge(app: &AppHandle, statuses: &[ForwardRuntimeStatus]) {
    set_active_forward_badge(app, active_forward_count(statuses));
}

fn active_forward_count(statuses: &[ForwardRuntimeStatus]) -> usize {
    statuses
        .iter()
        .filter(|status| is_forward_active(&status.state))
        .count()
}

fn is_forward_active(state: &RuntimeState) -> bool {
    matches!(
        state,
        RuntimeState::Starting | RuntimeState::Running | RuntimeState::Reconnecting
    )
}

#[cfg(target_os = "macos")]
fn set_active_forward_badge(app: &AppHandle, active_count: usize) {
    use tauri::Manager;

    let Some(window) = app.get_webview_window("main") else {
        return;
    };

    let label = (active_count > 0).then(|| active_count.to_string());
    if let Err(error) = window.set_badge_label(label) {
        eprintln!("failed to update dock badge: {error}");
    }
}

#[cfg(not(target_os = "macos"))]
fn set_active_forward_badge(_app: &AppHandle, _active_count: usize) {}

#[cfg(test)]
mod tests {
    use chrono::Utc;

    use super::active_forward_count;
    use crate::models::{ForwardRuntimeStatus, RuntimeState};

    #[test]
    fn active_forward_count_matches_frontend_active_states() {
        let statuses = [
            status("starting", RuntimeState::Starting),
            status("running", RuntimeState::Running),
            status("reconnecting", RuntimeState::Reconnecting),
            status("stopping", RuntimeState::Stopping),
            status("stopped", RuntimeState::Stopped),
            status("failed", RuntimeState::Failed),
        ];

        assert_eq!(active_forward_count(&statuses), 3);
    }

    fn status(id: &str, state: RuntimeState) -> ForwardRuntimeStatus {
        ForwardRuntimeStatus {
            forward_id: id.to_string(),
            state,
            message: None,
            bound_host: None,
            bound_port: None,
            started_at: None,
            updated_at: Utc::now().to_rfc3339(),
            reconnects: 0,
        }
    }
}
