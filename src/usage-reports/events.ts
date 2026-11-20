/**
 * Builds Segment-style `track` events for taxonomy-enforcer. Events carry no
 * `context` object: taxonomy-enforcer copies the client IP into an event only
 * when `context` is present.
 */

import { randomUUID } from 'node:crypto';

import {
  EVENT_PROPERTIES,
  EVENT_TYPE,
  PATH,
  PLATFORM,
  SECTION,
  type UsageEventName,
} from './constants.js';

export type PropertyValue = string | number | boolean;

export interface TrackEvent {
  readonly type: 'track';
  readonly event: UsageEventName;
  readonly anonymousId: string;
  readonly messageId: string;
  readonly timestamp: string;
  readonly properties: Readonly<Record<string, PropertyValue>>;
}

export interface EventIdentity {
  readonly installId: string;
  readonly sessionId: string;
  /** The field-list version the install consented to; newer fields are dropped. */
  readonly fieldListVersion: number;
}

export function buildEvent(
  name: UsageEventName,
  props: Readonly<Record<string, PropertyValue>>,
  identity: EventIdentity,
  now: Date = new Date(),
): TrackEvent {
  const allowed = EVENT_PROPERTIES[name];
  const properties: Record<string, PropertyValue> = {
    platform: PLATFORM,
    section: SECTION,
    path: PATH,
    event_type: EVENT_TYPE,
    session_id: identity.sessionId,
  };
  for (const [key, value] of Object.entries(props)) {
    const since = allowed[key];
    if (since === undefined || since > identity.fieldListVersion) continue;
    if (typeof value === 'string') properties[key] = value.slice(0, 64);
    else if (typeof value === 'number' && Number.isFinite(value)) properties[key] = value;
    else if (typeof value === 'boolean') properties[key] = value;
  }
  return {
    type: 'track',
    event: name,
    anonymousId: identity.installId,
    messageId: randomUUID(),
    timestamp: now.toISOString(),
    properties,
  };
}

/** Lowercase identifier, or `fallback` when the value isn't one. Keeps free text out. */
export function toIdentifier(value: string | undefined | null, fallback = 'other'): string {
  if (!value) return fallback;
  const v = value.toLowerCase();
  return /^[a-z0-9][a-z0-9_.-]{0,47}$/.test(v) ? v : fallback;
}
