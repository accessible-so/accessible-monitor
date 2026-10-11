import type { ReactNode } from 'react';
import { AccessibleMonitor } from '@accessible-so/monitor-next';

export const metadata = {
  title: 'Accessible Next example',
  description: 'Route-pattern and component attribution fixture.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <main>{children}</main>
        <AccessibleMonitor
          siteKey={process.env.NEXT_PUBLIC_A11Y_KEY ?? ''}
          endpoint={process.env.NEXT_PUBLIC_A11Y_ENDPOINT}
        />
      </body>
    </html>
  );
}
