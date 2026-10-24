import { Component, DestroyRef, ElementRef, HostListener, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { NavigationEnd, Router } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Subject, debounceTime, distinctUntilChanged, filter, of, switchMap, catchError } from 'rxjs';
import { EventService, SearchSuggestion, SearchSuggestions } from '../../services/event.service';
import { CityService } from '../../services/city.service';

const RECENT_KEY = 'bm_recent_searches';
const MAX_RECENT = 5;

const TRENDING: { label: string; params: Record<string, string> }[] = [
  { label: 'Comedy Shows', params: { category: 'Comedy' } },
  { label: 'Music Shows', params: { category: 'Concert' } },
  { label: 'Sports', params: { category: 'Sports' } },
  { label: 'Workshops', params: { category: 'Workshop' } },
  { label: 'This Weekend', params: { date: 'weekend' } },
];

/** Header search with BookMyShow-style live suggestions (events and movies). */
@Component({
  selector: 'app-search-box',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './search-box.component.html',
  styleUrls: ['./search-box.component.css'],
})
export class SearchBoxComponent {
  private es = inject(EventService);
  private cityService = inject(CityService);
  private router = inject(Router);
  private host = inject(ElementRef<HTMLElement>);

  readonly trending = TRENDING;
  readonly query = signal('');
  readonly open = signal(false);
  readonly loading = signal(false);
  readonly results = signal<SearchSuggestions | null>(null);
  readonly recent = signal<string[]>(this.readRecent());
  readonly active = signal(-1);

  private input$ = new Subject<string>();

  /** Flat list for keyboard navigation: events, then movies, then "see all". */
  readonly items = computed<SearchSuggestion[]>(() => {
    const r = this.results();
    return r ? [...r.events, ...r.movies] : [];
  });

  readonly showSuggestions = computed(() => this.query().trim().length >= 2);

  constructor() {
    const destroyRef = inject(DestroyRef);
    this.input$
      .pipe(
        debounceTime(180),
        distinctUntilChanged(),
        switchMap((q) => {
          if (q.trim().length < 2) {
            this.loading.set(false);
            return of(null);
          }
          this.loading.set(true);
          return this.es.suggest(q.trim(), this.cityService.currentCity).pipe(catchError(() => of(null)));
        }),
        takeUntilDestroyed(destroyRef)
      )
      .subscribe((res) => {
        this.loading.set(false);
        this.results.set(res);
        this.active.set(-1);
      });

    // Mirror the explore page's search text; close the dropdown on navigation.
    this.router.events
      .pipe(
        filter((e): e is NavigationEnd => e instanceof NavigationEnd),
        takeUntilDestroyed(destroyRef)
      )
      .subscribe((e) => {
        const tree = this.router.parseUrl(e.urlAfterRedirects);
        const onExplore = tree.root.children['primary']?.segments?.[0]?.path === 'explore';
        this.query.set(onExplore ? String(tree.queryParams['q'] || '') : '');
        this.open.set(false);
      });
  }

  onInput(value: string): void {
    this.query.set(value);
    this.open.set(true);
    this.input$.next(value);
  }

  onFocus(): void {
    this.open.set(true);
  }

  clear(input: HTMLInputElement): void {
    this.query.set('');
    this.results.set(null);
    this.input$.next('');
    input.focus();
  }

  onKeydown(ev: KeyboardEvent): void {
    const items = this.items();
    if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      this.open.set(true);
      this.active.set(Math.min(this.active() + 1, items.length - 1));
    } else if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      this.active.set(Math.max(this.active() - 1, -1));
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      const picked = items[this.active()];
      picked ? this.openItem(picked) : this.searchAll(this.query());
    } else if (ev.key === 'Escape') {
      this.open.set(false);
      (ev.target as HTMLInputElement).blur();
    }
  }

  searchAll(q: string): void {
    const text = q.trim();
    if (!text) return;
    this.remember(text);
    this.open.set(false);
    this.router.navigate(['/explore'], { queryParams: { q: text } });
  }

  openItem(item: SearchSuggestion): void {
    this.remember(this.query().trim() || item.title);
    this.open.set(false);
    this.router.navigate(['/events', item.id]);
  }

  openTrending(params: Record<string, string>): void {
    this.open.set(false);
    this.router.navigate(['/explore'], { queryParams: params });
  }

  removeRecent(term: string, ev: MouseEvent): void {
    ev.stopPropagation();
    this.saveRecent(this.recent().filter((t) => t !== term));
  }

  indexOf(item: SearchSuggestion): number {
    return this.items().indexOf(item);
  }

  dateLabel(s: SearchSuggestion): string {
    if (!s.isUpcoming) return 'Event ended';
    const start = new Date(s.startDate);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const next = start < today ? today : start;
    return next.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
  }

  @HostListener('document:mousedown', ['$event'])
  onDocumentClick(ev: MouseEvent): void {
    if (!this.host.nativeElement.contains(ev.target as Node)) this.open.set(false);
  }

  private remember(term: string): void {
    if (!term) return;
    this.saveRecent([term, ...this.recent().filter((t) => t.toLowerCase() !== term.toLowerCase())].slice(0, MAX_RECENT));
  }

  private readRecent(): string[] {
    try {
      const list = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
      return Array.isArray(list) ? list.filter((t) => typeof t === 'string').slice(0, MAX_RECENT) : [];
    } catch {
      return [];
    }
  }

  private saveRecent(list: string[]): void {
    this.recent.set(list);
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(list));
    } catch {
      /* storage unavailable: recent searches simply aren't kept */
    }
  }
}
