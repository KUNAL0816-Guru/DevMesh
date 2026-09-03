import { useMemo } from "react";
import type { TaskCard } from "../api/types.js";

interface Props {
  tasks: TaskCard[];
}

interface GraphLevel {
  tasks: TaskCard[];
}

function computeLevels(tasks: TaskCard[]): GraphLevel[] {
  if (tasks.length === 0) return [];

  const levels: GraphLevel[] = [];
  const placed = new Set<string>();

  let remaining = tasks.filter((t) => t.dependsOn.length === 0);

  while (remaining.length > 0) {
    levels.push({ tasks: remaining });
    for (const t of remaining) placed.add(t.id);

    remaining = tasks.filter(
      (t) =>
        !placed.has(t.id) &&
        t.dependsOn.every((dep) => placed.has(dep)),
    );
  }

  return levels;
}

export default function TaskGraph({ tasks }: Props) {
  const levels = useMemo(() => computeLevels(tasks), [tasks]);
  const byId = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);

  if (tasks.length === 0) {
    return <p className="muted">No tasks to display.</p>;
  }

  return (
    <div className="task-graph">
      {levels.map((level, li) => (
        <div key={li} className="task-graph-level">
          {li > 0 && <div className="task-graph-connector">↓</div>}
          <div className="task-graph-nodes">
            {level.tasks.map((task) => (
              <div
                key={task.id}
                className={`task-graph-node task-graph-node--${task.status}`}
              >
                <div className="task-graph-node-header">
                  <span className={`status-dot status-dot--${task.status}`} />
                  <span className="task-graph-node-title">{task.title}</span>
                </div>
                <div className="task-graph-node-meta">
                  <span className="task-graph-node-role">{task.role}</span>
                  {task.dependsOn.length > 1 && (
                    <span className="muted">
                      {task.dependsOn.length} deps
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
          {level.tasks.some((t) => t.dependsOn.length > 0) && (
            <div className="task-graph-deps">
              {level.tasks.map((task) =>
                task.dependsOn
                  .filter((dep) => !level.tasks.some((t) => t.id === dep))
                  .map((dep) => {
                    const depTask = byId.get(dep);
                    return (
                      <span key={`${task.id}-${dep}`} className="task-graph-dep-line muted">
                        {depTask?.title ?? dep.slice(0, 8)} → {task.title}
                      </span>
                    );
                  }),
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
