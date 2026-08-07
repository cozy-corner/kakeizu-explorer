// AuraDB Free auto-pauses after 72h of inactivity and only the owner can resume
// it from the console, so the copy must not promise that a reload fixes it —
// retry is for the transient failures (cold start, network).
export function ServiceNotice({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="border-rule bg-panel max-w-md rounded-md border p-4 text-sm">
      <p className="font-semibold">データベースに接続できません</p>
      <p className="text-muted mt-1">
        一時的に停止している可能性があります。復旧まで時間がかかることがあります。
      </p>
      <button
        type="button"
        onClick={onRetry}
        className="border-rule-strong hover:bg-tint mt-3 rounded-md border px-3 py-1"
      >
        再試行
      </button>
    </div>
  );
}
