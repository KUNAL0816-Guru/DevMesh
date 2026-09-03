import type { TaskCard } from "../api/types.js";

interface Props {
  tasks: TaskCard[];
}

export default function TaskList({ tasks }: Props) {
  return (
    <div className="task-list">
      {tasks.map((task) => (
        <div key={task.id} className="task-card">
          <div className="task-card-header">
            <span className={`status-badge status-badge--${task.status}`}>
              {task.status}
            </span>
            <span className="task-role">{task.role}</span>
            <strong className="task-title">{task.title}</strong>
          </div>
          <div className="task-card-meta">
            <span className="muted mono">{task.id.slice(0, 8)}</span>
            <span className="muted">
              Attempts {task.attempts}/{task.maxAttempts}
            </span>
            {task.dependsOn.length > 0 && (
              <span className="muted">
                Depends on {task.dependsOn.length} task{task.dependsOn.length > 1 ? "s" : ""}
              </span>
            )}
          </div>
          <p className="task-detail">{task.detail}</p>
        </div>
      ))}
    </div>
  );
}
