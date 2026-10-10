import type { HostCommand, ViewerCommand } from "../../src/shared/protocol";
import type { IconName } from "../ui/icons";

export type ActionId = ViewerCommand | HostCommand;

/**
 * One user action, shared by the toolbar, the "…" menu, keyboard shortcuts
 * and VS Code commands, so that each behaves (and is labelled) the same way.
 */
export interface Action {
  id: ActionId;
  label: string;
  icon?: IconName;
  /** Shown in tooltips and menus; the binding itself lives in package.json or keyboard.ts. */
  shortcut?: string;
  run(): void;
  checked?(): boolean;
  enabled?(): boolean;
}

export class ActionRegistry {
  readonly #actions = new Map<ActionId, Action>();

  register(...actions: Action[]): void {
    for (const action of actions) {
      this.#actions.set(action.id, action);
    }
  }

  get(id: ActionId): Action {
    const action = this.#actions.get(id);
    if (!action) {
      throw new Error(`Unknown action: ${id}`);
    }
    return action;
  }

  run(id: ActionId): void {
    const action = this.get(id);
    if (action.enabled?.() ?? true) {
      action.run();
    }
  }
}

export function tooltip(action: Action): string {
  return action.shortcut ? `${action.label} (${action.shortcut})` : action.label;
}
