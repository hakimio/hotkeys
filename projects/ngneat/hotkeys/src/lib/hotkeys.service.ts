import { DOCUMENT } from '@angular/common';
import { Inject, Injectable } from '@angular/core';
import { EventManager } from '@angular/platform-browser';
import { EMPTY, fromEvent, Observable, of, Subject, Subscription } from 'rxjs';
import { debounceTime, filter, mergeMap, takeUntil, tap } from 'rxjs/operators';

import { coerceArray } from './utils/array';
import { hostPlatform, normalizeKeys } from './utils/platform';

export type AllowInElement = 'INPUT' | 'TEXTAREA' | 'SELECT';
interface Options {
  group: string;
  element: HTMLElement;
  trigger: 'keydown' | 'keyup';
  allowIn: AllowInElement[];
  description: string;
  showInHelpMenu: boolean;
  preventDefault: boolean;
}

export interface HotkeyGroup {
  group: string;
  hotkeys: { keys: string; description: string }[];
}

export type Hotkey = Partial<Options> & { keys: string };
export type HotkeyCallback = (event: KeyboardEvent, keys: string, target: HTMLElement) => void;

interface HotkeySummary {
  hotkey: Hotkey;
  subject: Subject<Hotkey>;
}

interface SequenceSummary {
  subscription: Subscription;
  observer: Observable<Hotkey>;
  hotkeyMap: Map<string, HotkeySummary>;
}

@Injectable({ providedIn: 'root' })
export class HotkeysService {
  private readonly hotkeys = new Map<string, Hotkey>();
  private readonly dispose = new Subject<string>();
  private readonly defaults: Options = {
    trigger: 'keydown',
    allowIn: [],
    element: this.document.documentElement,
    group: undefined,
    description: undefined,
    showInHelpMenu: true,
    preventDefault: true
  };
  private callbacks: HotkeyCallback[] = [];
  private sequenceMaps = new Map<HTMLElement, SequenceSummary>();
  private sequenceDebounce: number = 250;

  constructor(private eventManager: EventManager, @Inject(DOCUMENT) private document) {}

  getHotkeys(): Hotkey[] {
    return Array.from(this.hotkeys.values()).map(h => ({ ...h }));
  }

  getShortcuts(): HotkeyGroup[] {
    const hotkeys = Array.from(this.hotkeys.values());
    const groups: HotkeyGroup[] = [];
    const sequenceKeys = Array.from(this.sequenceMaps.values())
      .map(s => [s.hotkeyMap].reduce((_acc, val) => [...val.values()], []))
      .reduce((_x, y) => y, [])
      .map(h => h.hotkey);

    for (const hotkey of hotkeys) {
      if (!hotkey.showInHelpMenu) {
        continue;
      }

      let group = groups.find(g => g.group === hotkey.group);
      if (!group) {
        group = { group: hotkey.group, hotkeys: [] };
        groups.push(group);
      }

      const normalizedKeys = normalizeKeys(hotkey.keys, hostPlatform());
      group.hotkeys.push({ keys: normalizedKeys, description: hotkey.description });
    }

    for (const hotkey of sequenceKeys) {
      if (!hotkey.showInHelpMenu) {
        continue;
      }

      let group = groups.find(g => g.group === hotkey.group);
      if (!group) {
        group = { group: hotkey.group, hotkeys: [] };
        groups.push(group);
      }

      const normalizedKeys = normalizeKeys(hotkey.keys, hostPlatform());
      group.hotkeys.push({ keys: normalizedKeys, description: hotkey.description });
    }

    return groups;
  }

  addSequenceShortcut(options: Hotkey): Observable<Hotkey> {
    const getObserver = (element: HTMLElement, eventName: string) => {
      let sequence = '';
      return fromEvent<KeyboardEvent>(element, eventName).pipe(
        tap(
          e =>
            (sequence = `${sequence}${sequence ? '>' : ''}${e.ctrlKey ? 'control.' : ''}${e.altKey ? 'alt.' : ''}${
              e.shiftKey ? 'shift.' : ''
            }${e.key}`)
        ),
        debounceTime(this.sequenceDebounce),
        mergeMap(() => {
          const resultSequence = sequence;
          sequence = '';
          const summary = this.sequenceMaps.get(element);
          if (summary.hotkeyMap.has(resultSequence)) {
            const hotkeySummary = summary.hotkeyMap.get(resultSequence);
            hotkeySummary.subject.next(hotkeySummary.hotkey);
            return of(hotkeySummary.hotkey);
          } else {
            return EMPTY;
          }
        })
      );
    };

    const mergedOptions = { ...this.defaults, ...options };
    let normalizedKeys = normalizeKeys(mergedOptions.keys, hostPlatform());

    if (this.sequenceMaps.has(mergedOptions.element)) {
      const sequenceSummary = this.sequenceMaps.get(mergedOptions.element);

      if (sequenceSummary.hotkeyMap.has(normalizedKeys)) {
        console.error('Duplicated shortcut');
        return of(null);
      }

      const hotkeySummary = {
        subject: new Subject<Hotkey>(),
        hotkey: mergedOptions
      };

      sequenceSummary.hotkeyMap.set(normalizedKeys, hotkeySummary);
      return hotkeySummary.subject.asObservable();
    } else {
      const observer = getObserver(mergedOptions.element, mergedOptions.trigger);
      const subscription = observer.subscribe();

      const hotkeySummary = {
        subject: new Subject<Hotkey>(),
        hotkey: mergedOptions
      };
      const hotkeyMap = new Map<string, HotkeySummary>([[normalizedKeys, hotkeySummary]]);
      const sequenceSummary = { subscription, observer, hotkeyMap };
      this.sequenceMaps.set(mergedOptions.element, sequenceSummary);

      return hotkeySummary.subject.asObservable();
    }
  }

  addShortcut(options: Hotkey): Observable<KeyboardEvent> {
    const mergedOptions = { ...this.defaults, ...options };
    const normalizedKeys = normalizeKeys(mergedOptions.keys, hostPlatform());

    if (this.hotkeys.has(normalizedKeys)) {
      console.error('Duplicated shortcut');
      return of(null);
    }

    this.hotkeys.set(normalizedKeys, mergedOptions);
    const event = `${mergedOptions.trigger}.${normalizedKeys}`;

    return new Observable(observer => {
      const handler = (e: KeyboardEvent) => {
        const hotkey = this.hotkeys.get(normalizedKeys);
        const excludedTargets = this.getExcludedTargets(hotkey.allowIn || []);

        const skipShortcutTrigger = excludedTargets && excludedTargets.includes(document.activeElement.nodeName);
        if (skipShortcutTrigger) {
          return;
        }

        if (mergedOptions.preventDefault) {
          e.preventDefault();
        }

        this.callbacks.forEach(cb => cb(e, normalizedKeys, hotkey.element));
        observer.next(e);
      };
      const dispose = this.eventManager.addEventListener(mergedOptions.element, event, handler);

      return () => {
        this.hotkeys.delete(normalizedKeys);
        dispose();
      };
    }).pipe(takeUntil<KeyboardEvent>(this.dispose.pipe(filter(v => v === normalizedKeys))));
  }

  removeShortcuts(hotkeys: string | string[]): void {
    const coercedHotkeys = coerceArray(hotkeys).map(hotkey => normalizeKeys(hotkey, hostPlatform()));
    coercedHotkeys.forEach(hotkey => {
      this.hotkeys.delete(hotkey);
      this.dispose.next(hotkey);

      this.sequenceMaps.forEach(v => {
        v.hotkeyMap.delete(hotkey);
        if (v.hotkeyMap.size === 0) {
          v.subscription.unsubscribe();
        }
      });
    });
  }

  setSequenceDebounce(debounce: number): void {
    this.sequenceDebounce = debounce;
  }

  onShortcut(callback: HotkeyCallback): () => void {
    this.callbacks.push(callback);

    return () => (this.callbacks = this.callbacks.filter(cb => cb !== callback));
  }

  registerHelpModal(openHelpModalFn: () => void, helpShortcut: string = '') {
    this.addShortcut({ keys: helpShortcut || 'shift.?', showInHelpMenu: false, preventDefault: false }).subscribe(e => {
      const skipMenu =
        /^(input|textarea|select)$/i.test(document.activeElement.nodeName) ||
        (e.target as HTMLElement).isContentEditable;

      if (!skipMenu && this.hotkeys.size) {
        openHelpModalFn();
      }
    });
  }

  private getExcludedTargets(allowIn: AllowInElement[]) {
    return ['INPUT', 'SELECT', 'TEXTAREA'].filter(t => !allowIn.includes(t as AllowInElement));
  }
}
