import { Bell } from '../ui';
import { useNotificationsUnread } from './hooks';
import { useUi } from './uiStore';
import { it } from '../i18n/it';
import styles from './NotificationBell.module.css';

export function NotificationBell({ onWood = true }: { onWood?: boolean }) {
  const { data: unread = 0 } = useNotificationsUnread();
  const open = useUi((s) => s.setNotificationsOpen);
  return (
    <button
      type="button"
      className={[styles.bell, onWood ? styles.onWood : ''].join(' ')}
      aria-label={it.notifications.bell(unread)}
      title={it.notifications.title}
      onClick={() => open(true)}
    >
      <Bell size={20} />
      {unread > 0 && (
        <span className={styles.count} aria-hidden="true">
          {unread > 99 ? '99+' : unread}
        </span>
      )}
    </button>
  );
}
