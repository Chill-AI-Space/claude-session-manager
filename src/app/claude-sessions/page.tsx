export default function SessionsEmptyState() {
  return (
    <div className="flex-1 flex items-center justify-center text-muted-foreground">
      <div className="text-center space-y-1">
        <p className="text-sm font-medium">No session selected</p>
        <p className="text-xs">
          Choose a session from the sidebar
        </p>
      </div>
    </div>
  );
}
