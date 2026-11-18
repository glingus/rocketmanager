import type { ReactNode } from 'react';
import { WoodHeader, type WoodHeaderProps } from '../ui';
import { NotificationBell } from './NotificationBell';

/** WoodHeader with the notification bell always on the right. */
export function PageHeader({ actions, ...rest }: WoodHeaderProps & { actions?: ReactNode }) {
  return (
    <WoodHeader
      {...rest}
      actions={
        <>
          {actions}
          <NotificationBell />
        </>
      }
    />
  );
}
