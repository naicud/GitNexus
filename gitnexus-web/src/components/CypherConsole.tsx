import { useState, useCallback } from 'react';
import { runCypherQuery } from '../services/backend';
import { useAppState } from '../hooks/useAppState';

interface Props {
  onClose: () => void;
}

export const CypherConsole: React.FC<Props> = ({ onClose }) => {
  const { projectName } = useAppState();
  const [query, setQuery] = useState('MATCH (n) RETURN n.name LIMIT 10');
  const [results, setResults] = useState<Record<string, unknown>[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [viewMode, setViewMode] = useState<'table' | 'json'>('table');

  const runQuery = useCallback(async () => {
    if (!query.trim()) return;
    setLoading(true);
    setError(null);
    setResults(null);
    try {
      const data = await runCypherQuery(projectName || 'project', query);
      setResults(data as Record<string, unknown>[]);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Query failed');
    } finally {
      setLoading(false);
    }
  }, [query, projectName]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      runQuery();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-gray-900 rounded-xl border border-white/10 w-full max-w-4xl h-[80vh] flex flex-col shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
          <h2 className="text-white font-semibold">Cypher Console</h2>
          <button onClick={onClose} className="text-white/40 hover:text-white transition-colors">✕</button>
        </div>

        {/* Query area */}
        <div className="p-4 border-b border-white/10">
          <textarea
            className="w-full bg-black/40 text-green-300 font-mono text-sm rounded-lg p-3 border border-white/10 focus:border-white/30 focus:outline-none resize-none"
            rows={5}
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="MATCH (n:Function) RETURN n.name, n.filePath LIMIT 20"
            spellCheck={false}
          />
          <div className="flex items-center gap-3 mt-2">
            <button
              onClick={runQuery}
              disabled={loading || !query.trim()}
              className="px-4 py-1.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-sm rounded-lg font-medium transition-colors"
            >
              {loading ? 'Running...' : 'Run (Ctrl+Enter)'}
            </button>
            <span className="text-white/30 text-xs">openCypher query against the knowledge graph</span>
          </div>
        </div>

        {/* Results */}
        <div className="flex-1 overflow-hidden flex flex-col">
          {error && (
            <div className="m-4 p-3 bg-red-900/30 border border-red-500/30 rounded-lg text-red-300 text-sm font-mono">
              {error}
            </div>
          )}
          {results !== null && (
            <>
              <div className="flex items-center gap-2 px-4 py-2 border-b border-white/5">
                <span className="text-white/40 text-xs">{results.length} row{results.length !== 1 ? 's' : ''}</span>
                <div className="ml-auto flex gap-1">
                  <button
                    onClick={() => setViewMode('table')}
                    className={`px-2 py-0.5 text-xs rounded ${viewMode === 'table' ? 'bg-white/10 text-white' : 'text-white/40 hover:text-white'}`}
                  >Table</button>
                  <button
                    onClick={() => setViewMode('json')}
                    className={`px-2 py-0.5 text-xs rounded ${viewMode === 'json' ? 'bg-white/10 text-white' : 'text-white/40 hover:text-white'}`}
                  >JSON</button>
                </div>
              </div>
              <div className="flex-1 overflow-auto p-4">
                {viewMode === 'table' ? (
                  results.length > 0 ? (
                    <table className="w-full text-sm text-left border-collapse">
                      <thead>
                        <tr>
                          {Object.keys(results[0]).map(col => (
                            <th key={col} className="px-3 py-2 text-white/60 text-xs font-medium border-b border-white/10 sticky top-0 bg-gray-900">{col}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {results.map((row, i) => (
                          <tr key={i} className="border-b border-white/5 hover:bg-white/5">
                            {Object.values(row).map((val, j) => (
                              <td key={j} className="px-3 py-1.5 text-white/80 font-mono text-xs max-w-xs truncate">
                                {val === null || val === undefined ? <span className="text-white/20">null</span> : typeof val === 'object' ? JSON.stringify(val) : String(val)}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : <p className="text-white/30 text-sm">No results</p>
                ) : (
                  <pre className="text-green-300/80 font-mono text-xs whitespace-pre-wrap">{JSON.stringify(results, null, 2)}</pre>
                )}
              </div>
            </>
          )}
          {results === null && !error && !loading && (
            <div className="flex-1 flex items-center justify-center text-white/20 text-sm">Run a query to see results</div>
          )}
        </div>
      </div>
    </div>
  );
};
