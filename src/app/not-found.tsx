import Link from 'next/link';

export default function NotFound() {
  return <div className="route-error">
    <h1>Page not found</h1>
    <p>The page you’re looking for doesn’t exist.</p>
    <Link href="/" className="button button-accent">Back to dashboard</Link>
  </div>;
}
