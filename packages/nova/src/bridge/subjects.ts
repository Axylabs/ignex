/**
 * NATS subject naming for the ignex bridge.
 *
 * Every publish the server fans out to WS clients can ALSO be bridged to NATS
 * so other applications consume the exact same FlatBuffer wire frame. Subjects
 * are derived from the routing context:
 *
 *   - global publish            → `{prefix}.broadcast.{event}`
 *   - publishToTopic(topic,..)  → `{prefix}.topic.{topic}.{event}`
 *   - publishToGroup(group,..)  → `{prefix}.group.{group}.{event}`
 *
 * External apps push events INTO the hub by publishing on `{prefix}.inbound.>`
 * (the default inbound subscription; the server forwards them to all clients).
 */
export interface SubjectBuilder {
  broadcast(name: string): string;
  topic(topic: string, name: string): string;
  group(group: string, name: string): string;
  /** wildcard subject the server subscribes to for inbound events */
  inboundPrefix(): string;
  /** concrete inbound subject for one event — used to re-publish client events into the cluster */
  inboundEvent(name: string): string;
}

export function createSubjectBuilder(prefix = "ignex"): SubjectBuilder {
  return {
    broadcast: (name) => `${prefix}.broadcast.${name}`,
    topic: (topic, name) => `${prefix}.topic.${topic}.${name}`,
    group: (group, name) => `${prefix}.group.${group}.${name}`,
    inboundPrefix: () => `${prefix}.inbound.>`,
    inboundEvent: (name) => `${prefix}.inbound.${name}`,
  };
}
