import { headers } from 'next/headers';
import { LoginForm } from '@/components/login-form';
import { demoEnabled, isLoopbackHost } from '@/lib/server/security';

export const dynamic = 'force-dynamic';
export default async function LoginPage() {
  const host = (await headers()).get('host')?.toLowerCase() ?? '';
  const demoAllowed = demoEnabled() && isLoopbackHost(host);
  return <LoginForm demoAllowed={demoAllowed}/>;
}
