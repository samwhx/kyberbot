import { useState, useEffect } from 'react';
import MainLayout from './components/layout/MainLayout';

function TokenPrompt({ onSubmit }: { onSubmit: (token: string) => void }) {
  const [value, setValue] = useState('');

  return (
    <div className="h-screen flex flex-col items-center justify-center bg-[#F0EFEA] dark:bg-[#0a0a0a] transition-colors duration-300">
      <div className="text-[9px] text-violet-600 dark:text-violet-400 tracking-[2px] font-mono mb-6">
        {'// KYBERBOT_AUTH'}
      </div>
      <h2
        className="text-xl text-slate-800 dark:text-white/90 mb-2"
        style={{ fontFamily: 'Inter, system-ui, sans-serif', fontWeight: 400 }}
      >
        Enter API Token
      </h2>
      <p
        className="text-sm text-slate-500 dark:text-white/50 mb-6 max-w-sm text-center"
        style={{ fontFamily: 'Inter, system-ui, sans-serif', fontWeight: 300 }}
      >
        Paste your KYBERBOT_API_TOKEN to connect. Run <code className="text-[11px] bg-slate-200 dark:bg-white/10 px-1 py-0.5 rounded font-mono">kyberbot token</code> in your agent directory to get it.
      </p>
      <div className="flex gap-3">
        <input
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && value.trim() && onSubmit(value.trim())}
          placeholder="kb_..."
          className="w-80 bg-slate-50 dark:bg-white/[0.02] border border-slate-200 dark:border-white/10 px-4 py-3 text-sm text-slate-800 dark:text-white placeholder-slate-400 dark:placeholder-white/30 focus:border-violet-500/40 dark:focus:border-violet-400/40 focus:outline-none transition font-mono"
          autoFocus
        />
        <button
          onClick={() => value.trim() && onSubmit(value.trim())}
          disabled={!value.trim()}
          className="border border-violet-500/40 dark:border-violet-400/40 bg-violet-500/10 dark:bg-violet-400/10 px-6 py-3 text-[10px] text-violet-600 dark:text-violet-400 hover:bg-violet-500/20 dark:hover:bg-violet-400/20 transition tracking-[1px] disabled:opacity-30 disabled:cursor-not-allowed font-mono"
        >
          CONNECT
        </button>
      </div>
    </div>
  );
}

export default function App() {
  const [token, setToken] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    // Tokens via ?token=... were removed: the URL is logged by access logs,
    // browser history, referer headers, ngrok/Tailscale logs, etc. If a stale
    // ?token=... is in the URL, strip it without using it (so refreshing the
    // tab can't keep leaking it through the address bar).
    const params = new URLSearchParams(window.location.search);
    if (params.has('token')) {
      window.history.replaceState({}, '', window.location.pathname);
    }
    setToken(sessionStorage.getItem('kyberbot_token'));
    setChecked(true);
  }, []);

  // Theme initialization
  useEffect(() => {
    const saved = localStorage.getItem('kyberbot_theme');
    if (saved === 'light') {
      document.documentElement.classList.remove('dark');
    } else {
      document.documentElement.classList.add('dark');
    }
  }, []);

  if (!checked) return null;

  // If no token and auth is likely required, show token prompt
  // First, try a health check to see if auth is even needed
  if (!token) {
    return (
      <TokenPrompt
        onSubmit={(t) => {
          sessionStorage.setItem('kyberbot_token', t);
          setToken(t);
        }}
      />
    );
  }

  return <MainLayout token={token} />;
}
