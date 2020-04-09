/*
 * Copyright (C) 2018-2020 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { registerCleanupFunction } from "../util/util"
import { Events, EventName, EventBus, eventNames } from "../events"
import { LogEntryMetadata, LogEntry } from "../logger/log-entry"
import { chainMessages } from "../logger/renderers"
import { got } from "../util/http"

export type StreamEvent = {
  name: EventName
  payload: Events[EventName]
  timestamp: Date
}

export interface LogEntryEvent {
  key: string
  parentKey: string | null
  revision: number
  msg: string | string[]
  timestamp: Date
  data?: any
  section?: string
  metadata?: LogEntryMetadata
}

export function formatForEventStream(entry: LogEntry): LogEntryEvent {
  const { section, data } = entry.getMessageState()
  const { key, revision } = entry
  const parentKey = entry.parent ? entry.parent.key : null
  const metadata = entry.getMetadata()
  const msg = chainMessages(entry.getMessageStates() || [])
  const timestamp = new Date()
  return { key, parentKey, revision, msg, data, metadata, section, timestamp }
}

export const FLUSH_INTERVAL_MSEC = 1000
export const MAX_BATCH_SIZE = 100

/**
 * Buffers events and log entries and periodically POSTs them to the platform.
 *
 * Subscribes to logger events once, in the constructor.
 *
 * Subscribes to Garden events via the connect method, since we need to subscribe to the event bus of
 * new Garden instances (and unsubscribe from events from the previously connected Garden instance, if
 * any) e.g. when config changes during a watch-mode command.
 */
export class BufferedEventStream {
  private log: LogEntry
  private eventBus: EventBus
  public sessionId: string
  private platformUrl: string
  private clientAuthToken: string

  /**
   * We maintain this map to facilitate unsubscribing from a previously connected event bus
   * when a new event bus is connected.
   */
  private gardenEventListeners: { [eventName: string]: (payload: any) => void }

  private intervalId: NodeJS.Timer | null
  private bufferedEvents: StreamEvent[]
  private bufferedLogEntries: LogEntryEvent[]

  // For testing.
  public flushEventsTestHandler: null | ((events: StreamEvent[]) => void)
  public flushLogEntriesTestHandler: null | ((logEntries: LogEntryEvent[]) => void)

  constructor(log: LogEntry, sessionId: string) {
    this.sessionId = sessionId
    this.log = log
    this.log.root.events.onAny((_name: string, payload: LogEntryEvent) => {
      this.streamLogEntry(payload)
    })
    this.flushEventsTestHandler = null
    this.flushLogEntriesTestHandler = null
    this.bufferedEvents = []
    this.bufferedLogEntries = []
  }

  connect(eventBus: EventBus, clientAuthToken: string, platformUrl: string) {
    this.clientAuthToken = clientAuthToken
    this.platformUrl = platformUrl

    if (!this.intervalId) {
      this.startInterval()
    }

    if (this.eventBus) {
      // We unsubscribe from the old event bus' events.
      this.unsubscribeFromGardenEvents(this.eventBus)
    }

    this.eventBus = eventBus
    this.subscribeToGardenEvents(this.eventBus)
  }

  subscribeToGardenEvents(eventBus: EventBus) {
    // We maintain this map to facilitate unsubscribing from events when the Garden instance is closed.
    const gardenEventListeners = {}
    for (const gardenEventName of eventNames) {
      const listener = (payload: LogEntryEvent) => this.streamEvent(gardenEventName, payload)
      gardenEventListeners[gardenEventName] = listener
      eventBus.on(gardenEventName, listener)
    }
    this.gardenEventListeners = gardenEventListeners
  }

  unsubscribeFromGardenEvents(eventBus: EventBus) {
    for (const [gardenEventName, listener] of Object.entries(this.gardenEventListeners)) {
      eventBus.removeListener(gardenEventName, listener)
    }
  }

  startInterval() {
    this.intervalId = setInterval(() => {
      this.flushBuffered({ flushAll: false })
    }, FLUSH_INTERVAL_MSEC)

    registerCleanupFunction("flushAllBufferedEventsAndLogEntries", () => {
      this.close()
    })
  }

  close() {
    if (this.intervalId) {
      clearInterval(this.intervalId)
      this.intervalId = null
    }
    this.flushBuffered({ flushAll: true })
  }

  streamEvent<T extends EventName>(name: T, payload: Events[T]) {
    this.bufferedEvents.push({
      name,
      payload,
      timestamp: new Date(),
    })
  }

  streamLogEntry(logEntry: LogEntryEvent) {
    this.bufferedLogEntries.push(logEntry)
  }

  flushEvents(events: StreamEvent[]) {
    const data = {
      events,
      clientAuthToken: this.clientAuthToken,
      sessionId: this.sessionId,
    }
    got.post(`${this.platformUrl}/events`, { json: data }).catch((err) => {
      this.log.error(err)
    })
  }

  flushLogEntries(logEntries: LogEntryEvent[]) {
    const data = {
      logEntries,
      clientAuthToken: this.clientAuthToken,
      sessionId: this.sessionId,
    }
    got.post(`${this.platformUrl}/log-entries`, { json: data }).catch((err) => {
      this.log.error(err)
    })
  }

  flushBuffered({ flushAll = false }) {
    if (!this.clientAuthToken || !this.platformUrl) {
      return
    }
    const eventsToFlush = this.bufferedEvents.splice(0, flushAll ? this.bufferedEvents.length : MAX_BATCH_SIZE)

    if (eventsToFlush.length > 0) {
      this.flushEventsTestHandler ? this.flushEventsTestHandler(eventsToFlush) : this.flushEvents(eventsToFlush)
    }

    const logEntryFlushCount = flushAll ? this.bufferedLogEntries.length : MAX_BATCH_SIZE - eventsToFlush.length
    const logEntriesToFlush = this.bufferedLogEntries.splice(0, logEntryFlushCount)

    if (logEntriesToFlush.length > 0) {
      this.flushLogEntriesTestHandler
        ? this.flushLogEntriesTestHandler(logEntriesToFlush)
        : this.flushLogEntries(logEntriesToFlush)
    }
  }
}
