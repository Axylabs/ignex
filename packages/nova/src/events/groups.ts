/**
 * Groups — named fan-out dimensions with explicit differentiation:
 *
 *   - CLIENT groups (`hub.group(name)`): membership by connection id. These
 *     reuse the transport's group registry (`state.groups`), so auth-seeded
 *     groups, control frames (`client.joinGroup`), `server.joinGroup` and the
 *     events layer all see the SAME membership.
 *   - USER groups (`hub.userGroup(name)`): membership by `userId`. Emitting to
 *     a user group fans out to every socket acting on behalf of each member
 *     user — the "broadcast to a group of people" case, independent of how
 *     many devices each person has open.
 *
 * Both are cluster-aware at the hub level: emit → `emitToGroup` / `emitToUser`
 * (which publish to the cluster subjects), and membership syncs to the shared
 * state store when one is configured.
 */
import type { ServerWebSocket } from "bun";
import type { Bindings, DefaultBindings, EventNameOf, EventsOf } from "../bindings/types";
import {
  activeGroups,
  joinGroup,
  leaveGroup,
  groupMembers as stateGroupMembers,
} from "../core/groups";
import type { ServerState, WsData } from "../core/state";
import type { ClientGroup, UserGroup } from "./types";

export interface GroupManager<B extends Bindings = DefaultBindings> {
  clientGroup(name: string): ClientGroup<B>;
  clientGroups(): string[];
  userGroup(name: string): UserGroup<B>;
  userGroups(): string[];
}

export interface GroupManagerOptions<B extends Bindings = DefaultBindings> {
  state: ServerState;
  emitToGroup: <K extends EventNameOf<B>>(group: string, name: K, payload: EventsOf<B>[K]) => void;
  emitToUser: <K extends EventNameOf<B>>(userId: string, name: K, payload: EventsOf<B>[K]) => void;
  /** fired on user-group membership change (hub wires cluster sync here) */
  onUserGroupChange?: (name: string, members: ReadonlySet<string>) => void;
}

export function createGroupManager<B extends Bindings = DefaultBindings>(
  opts: GroupManagerOptions<B>,
): GroupManager<B> {
  const userGroupsMap = new Map<string, Set<string>>();

  const touchUserGroup = (name: string): void => {
    opts.onUserGroupChange?.(name, userGroupsMap.get(name) ?? new Set());
  };

  const userGroupHandle = (name: string): UserGroup<B> => {
    let set = userGroupsMap.get(name);
    if (!set) {
      set = new Set();
      userGroupsMap.set(name, set);
    }
    return {
      get name(): string {
        return name;
      },
      add(userId) {
        set!.add(userId);
        touchUserGroup(name);
      },
      remove(userId) {
        const existed = set!.delete(userId);
        if (existed) {
          if (set!.size === 0) userGroupsMap.delete(name);
          touchUserGroup(name);
        }
      },
      has(userId) {
        return set!.has(userId);
      },
      members() {
        return [...set!];
      },
      get size(): number {
        return set!.size;
      },
      emit(event, payload) {
        const snapshot = [...set!];
        for (const userId of snapshot) opts.emitToUser(userId, event, payload);
      },
    };
  };

  const clientGroupHandle = (name: string): ClientGroup<B> => {
    const socket = (clientId: string): ServerWebSocket<WsData> | undefined =>
      opts.state.clients.get(clientId);
    return {
      get name(): string {
        return name;
      },
      add(clientId) {
        const ws = socket(clientId);
        if (ws) joinGroup(opts.state, ws, name);
      },
      remove(clientId) {
        const ws = socket(clientId);
        if (ws) leaveGroup(opts.state, ws, name);
      },
      has(clientId) {
        const ws = socket(clientId);
        return ws !== undefined && ws.data.groups.has(name);
      },
      members() {
        return stateGroupMembers(opts.state, name);
      },
      get size(): number {
        return stateGroupMembers(opts.state, name).length;
      },
      emit(event, payload) {
        opts.emitToGroup(name, event, payload);
      },
    };
  };

  return {
    clientGroup: clientGroupHandle,
    clientGroups: () => activeGroups(opts.state),
    userGroup: userGroupHandle,
    userGroups: () => [...userGroupsMap.keys()],
  };
}
