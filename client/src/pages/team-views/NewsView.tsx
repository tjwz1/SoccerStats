import { useApi } from "../../hooks/useApi";

interface NewsArticle {
  title: string;
  url: string;
  source: string;
  publishedAt: string;
}

interface NewsResponse {
  digest: string[];
  articles: NewsArticle[];
}

interface Props {
  teamId: number;
  teamName: string;
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function NewsDigest({ bullets }: { bullets: string[] }) {
  if (bullets.length === 0) return null;
  return (
    <div className="mb-4 rounded-xl border border-slate-700/40 bg-gradient-to-br from-slate-800/80 to-slate-900/60 p-4">
      <div className="flex items-center gap-1.5 mb-3">
        <svg className="w-3.5 h-3.5 text-green-400 shrink-0" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 2l1.34 5.47L19 9l-5.66 1.53L12 16l-1.34-5.47L5 9l5.66-1.53L12 2z" />
        </svg>
        <span className="text-[10px] font-semibold text-green-400 uppercase tracking-widest">Overview</span>
      </div>
      <ul className="space-y-2">
        {bullets.map((bullet, i) => (
          <li key={i} className="flex gap-2 text-xs text-slate-300 leading-relaxed">
            <span className="text-green-500/50 shrink-0 mt-px select-none">›</span>
            <span>{bullet}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function NewsView({ teamId, teamName }: Props) {
  const { data, loading, error, retry } = useApi<NewsResponse>(
    `/api/teams/${teamId}/news?name=${encodeURIComponent(teamName)}`
  );

  if (loading) {
    return (
      <div className="flex flex-col items-center gap-3 py-20 text-slate-500">
        <div className="w-6 h-6 border-2 border-slate-600 border-t-white rounded-full animate-spin" />
        <p className="text-sm">Loading news…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center gap-3 py-20 text-slate-500">
        <p className="text-sm">Could not load news.</p>
        <button
          onClick={retry}
          className="px-4 py-1.5 bg-slate-700 hover:bg-slate-600 text-white text-xs rounded-lg transition-colors"
        >
          Retry
        </button>
      </div>
    );
  }

  const articles = data?.articles ?? [];

  if (articles.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-20 text-slate-500">
        <p className="text-sm">No recent news found for {teamName}.</p>
      </div>
    );
  }

  return (
    <div className="space-y-2 w-full">
      <NewsDigest bullets={data?.digest ?? []} />
      <p className="text-[10px] text-slate-600 text-right mb-3 uppercase tracking-wider">
        Via Google News · Updates every 15 min
      </p>
      {articles.map((article, i) => (
        <a
          key={i}
          href={article.url}
          target="_blank"
          rel="noopener noreferrer"
          className="block bg-slate-800/60 border border-slate-700/60 rounded-xl p-3.5 hover:border-slate-600/60 hover:bg-slate-800 transition-colors group"
        >
          <p className="text-sm font-medium text-white leading-snug group-hover:text-green-400 transition-colors line-clamp-2 mb-2">
            {article.title}
          </p>
          <div className="flex items-center justify-between gap-2">
            <span className="text-[10px] font-semibold text-slate-400 bg-slate-700/60 px-2 py-0.5 rounded-full truncate max-w-[70%]">
              {article.source}
            </span>
            <span className="text-[10px] text-slate-500 shrink-0">
              {timeAgo(article.publishedAt)}
            </span>
          </div>
        </a>
      ))}
    </div>
  );
}
