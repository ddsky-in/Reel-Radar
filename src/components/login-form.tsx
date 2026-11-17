'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowRight, ArrowUpRight, Eye, EyeOff } from 'lucide-react';
import { api, errorMessage } from '@/lib/client';
import { Logo, SubmitButton } from './ui';

export function LoginForm({ demoAllowed }: { demoAllowed: boolean }) {
  const router = useRouter();
  const [email, setEmail] = useState(''), [password, setPassword] = useState(''), [showPassword, setShowPassword] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function login(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try { await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }); router.replace('/dashboard'); router.refresh(); }
    catch (error) { setError(errorMessage(error)); } finally { setBusy(false); }
  }
  return <div className="login-page">
    <main className="login-main">
      <div className="login-form-wrap">
        <Logo/>
        <h1>Sign in</h1>
        <form onSubmit={login}>
          <label className="field">Email address
            <input type="email" value={email} onChange={event => setEmail(event.target.value)} autoComplete="email" placeholder="you@example.com" required/>
          </label>
          <label className="field">Password
            <div className="password-field">
              <input type={showPassword ? 'text' : 'password'} value={password} onChange={event => setPassword(event.target.value)} autoComplete="current-password" required maxLength={256} placeholder="Your password"/>
              <button type="button" className="icon-button" onClick={() => setShowPassword(!showPassword)} aria-label={showPassword ? 'Hide password' : 'Show password'}>
                {showPassword ? <EyeOff size={17}/> : <Eye size={17}/>}
              </button>
            </div>
          </label>
          {error && <p className="inline-error" role="alert">{error}</p>}
          <SubmitButton busy={busy}>Sign in<ArrowRight size={17}/></SubmitButton>
        </form>
        {demoAllowed && <div className="login-demo">
          <Link href="/dashboard" className="text-link">Open local demo<ArrowUpRight size={14}/></Link>
          <p>Synthetic data, not live Instagram data. No provider calls.</p>
        </div>}
        <p className="login-security">Owner-only access. No public sign-ups.</p>
      </div>
    </main>
  </div>;
}
