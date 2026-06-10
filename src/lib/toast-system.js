import { escapeHtml } from './metrics-helpers.js';

/**
 * Toast Notification System
 * Provides non-intrusive notifications with screen reader support
 */

const TOAST_STATE = {
    container: null,
    toasts: [],
    maxToasts: 5,
};

/**
 * Initialize the toast container
 */
function createToastContainer() {
    if (document.getElementById('toast-container')) return;

    const container = document.createElement('div');
    container.id = 'toast-container';
    container.setAttribute('role', 'region');
    container.setAttribute('aria-label', 'Notifications');
    container.style.cssText = `
    position: fixed;
    top: 16px;
    right: 16px;
    z-index: 2500;
    display: flex;
    flex-direction: column;
    gap: 8px;
    max-width: 400px;
    pointer-events: none;
  `;
    document.body.appendChild(container);
    TOAST_STATE.container = container;
}

/**
 * Announce message to screen readers
 */
function announceToScreenReader(message, priority = 'polite') {
    let announcer = document.getElementById('sr-announcer');
    if (!announcer) {
        announcer = document.createElement('div');
        announcer.id = 'sr-announcer';
        announcer.setAttribute('aria-live', priority);
        announcer.setAttribute('aria-atomic', 'true');
        announcer.className = 'sr-only';
        document.body.appendChild(announcer);
    }
    announcer.textContent = message;
    setTimeout(() => { announcer.textContent = ''; }, 1000);
}

/**
 * Show a toast notification
 * @param {Object} options
 * @param {string} options.message - Toast message
 * @param {string} options.type - 'info' | 'success' | 'warning' | 'error'
 * @param {number} options.duration - Duration in milliseconds (default: 5000)
 * @param {boolean} options.announce - Whether to announce to screen readers
 */
export function showToast({
    message,
    type = 'info',
    duration = 5000,
    announce = true,
} = {}) {
    createToastContainer();

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
    toast.setAttribute('aria-live', type === 'error' ? 'assertive' : 'polite');
    toast.style.cssText = `
    background: linear-gradient(135deg, var(--bg2), var(--bg3));
    border: 1px solid var(--border2);
    border-radius: 8px;
    padding: 12px 16px;
    display: flex;
    align-items: center;
    gap: 10px;
    box-shadow: 0 4px 20px rgba(0, 0, 0, .4);
    pointer-events: auto;
    animation: toast-in 0.3s ease;
    min-width: 280px;
  `;

    // Icon based on type
    const icons = {
        info: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>`,
        success: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--accent2)" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="m9 11 3 3L22 4"/></svg>`,
        warning: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--warn)" stroke-width="2"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>`,
        error: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--danger)" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/></svg>`,
    };

    toast.innerHTML = `
    <span class="toast-icon" aria-hidden="true">${icons[type] || icons.info}</span>
    <span class="toast-message" style="flex:1;font-size:12px;color:var(--text);">${escapeHtml(message)}</span>
    <button class="toast-close" aria-label="Close notification" style="background:none;border:none;color:var(--muted);cursor:pointer;padding:4px;font-size:14px;line-height:1;">&times;</button>
  `;

    // Close button
    toast.querySelector('.toast-close').addEventListener('click', () => {
        removeToast(toast);
    });

    // Add to container
    TOAST_STATE.container.appendChild(toast);
    TOAST_STATE.toasts.push(toast);

    // Announce to screen readers
    if (announce) {
        announceToScreenReader(message, type === 'error' ? 'assertive' : 'polite');
    }

    // Auto remove
    if (duration > 0) {
        setTimeout(() => removeToast(toast), duration);
    }

    // Limit max toasts
    while (TOAST_STATE.toasts.length > TOAST_STATE.maxToasts) {
        removeToast(TOAST_STATE.toasts[0]);
    }

    return toast;
}

/**
 * Remove a toast notification
 */
function removeToast(toast) {
    if (!toast || !toast.parentNode) return;
    toast.style.animation = 'toast-out 0.3s ease forwards';
    setTimeout(() => {
        if (toast.parentNode) {
            toast.parentNode.removeChild(toast);
        }
        const index = TOAST_STATE.toasts.indexOf(toast);
        if (index > -1) {
            TOAST_STATE.toasts.splice(index, 1);
        }
    }, 300);
}

/**
 * Show a success toast
 */
export function showToastSuccess(message, duration) {
    return showToast({ message, type: 'success', duration });
}

/**
 * Show an error toast
 */
export function showToastError(message, duration = 8000) {
    return showToast({ message, type: 'error', duration });
}

/**
 * Show a warning toast
 */
export function showToastWarning(message, duration) {
    return showToast({ message, type: 'warning', duration });
}

/**
 * Show an info toast
 */
export function showToastInfo(message, duration) {
    return showToast({ message, type: 'info', duration });
}

// Add toast animations to document
const toastStyles = document.createElement('style');
toastStyles.textContent = `
  @keyframes toast-in {
    from { opacity: 0; transform: translateX(100%); }
    to { opacity: 1; transform: translateX(0); }
  }
  @keyframes toast-out {
    from { opacity: 1; transform: translateX(0); }
    to { opacity: 0; transform: translateX(100%); }
  }
  .toast-icon { display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
  .toast-close:hover { color: var(--text) !important; }
`;
document.head.appendChild(toastStyles);
