import { AfterViewInit, Component, ElementRef, OnDestroy, OnInit, ViewChild, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import { EventService } from '../../services/event.service';
import { AuthService } from '../../auth/auth.service';
import { environment } from '../../../environments/environment';

type CreateEventStep = 'basics' | 'schedule' | 'tickets' | 'publish';
type LocationMode = 'Offline' | 'Online';

interface StepDef {
  key: CreateEventStep;
  title: string;
  hint: string;
}

const DRAFT_KEY = 'tamasha_create_event_draft';
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Fields kept in the local draft (everything except the poster file). */
const DRAFT_FIELDS = [
  'title', 'tagline', 'description', 'category', 'customCategory', 'language', 'ageRestriction',
  'locationMode', 'venue', 'meetingLink', 'multiDay', 'startDate', 'endDate', 'showTimes',
  'isFree', 'price', 'totalSeats', 'themeColor',
] as const;

@Component({
  standalone: true,
  selector: 'app-create-event',
  imports: [CommonModule, FormsModule, RouterModule],
  templateUrl: './create-event.component.html',
  styleUrls: ['./create-event.component.css'],
})
export class CreateEventComponent implements OnInit, AfterViewInit, OnDestroy {
  private es = inject(EventService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private auth = inject(AuthService);

  readonly steps: StepDef[] = [
    { key: 'basics', title: 'Basics', hint: 'Name, category & story' },
    { key: 'schedule', title: 'When & where', hint: 'Dates, shows & venue' },
    { key: 'tickets', title: 'Tickets', hint: 'Price & seats' },
    { key: 'publish', title: 'Poster & publish', hint: 'Banner & final check' },
  ];
  step: CreateEventStep = 'basics';
  /** Steps the creator tried to leave: their missing fields are highlighted from then on. */
  private attempted = new Set<CreateEventStep>();
  /** Steps the creator has opened; only those get a ✓ in the stepper. */
  private visited = new Set<CreateEventStep>(['basics']);

  isEdit = false;
  eventId: string | null = null;

  // ── Basics ──
  title = '';
  tagline = '';
  description = '';
  category = '';
  customCategory = '';
  readonly customCategoryValue = '__custom__';
  categories: string[] = [];
  private readonly defaultCategories = ['Comedy', 'Concert', 'Plays', 'Sports', 'Workshop', 'Seminar', 'Activities'];
  private readonly categoryEmoji: Record<string, string> = {
    comedy: '😂', concert: '🎵', plays: '🎭', sports: '🏟️', workshop: '🛠️', seminar: '🎤',
    activities: '🎯', movie: '🎬', conference: '💼', webinar: '💻',
  };
  readonly languages = ['English', 'Hindi', 'Hinglish', 'Marathi', 'Tamil', 'Telugu', 'Kannada', 'Bengali', 'Other'];
  language = 'English';
  readonly ageOptions = ['All Ages', '5+', '12+', '16+', '18+', '21+'];
  ageRestriction = 'All Ages';

  // ── When & where ──
  locationMode: LocationMode = 'Offline';
  venue = '';
  meetingLink = '';
  multiDay = false;
  startDate = '';
  endDate = '';
  showTimes: string[] = ['19:00'];
  newTime = '';
  readonly timePresets = ['11:00', '14:00', '17:00', '19:00', '20:30', '22:00'];

  // ── Tickets ──
  isFree = false;
  price: number | null = 499;
  readonly pricePresets = [199, 299, 499, 799, 999];
  totalSeats: number | null = 100;
  readonly seatPresets = [50, 100, 200, 500];

  // ── Poster ──
  themeColor = '#d6b67a';
  readonly themeColors = ['#d6b67a', '#e5484d', '#7c5cff', '#18a0fb', '#10b981', '#f97316'];
  selectedFile: File | null = null;
  imagePreviewUrl: string | null = null;
  existingImageUrl: string | null = null;
  dragOver = false;
  private readonly maxImageBytes = 5 * 1024 * 1024;

  // Fields the form does not edit, carried through unchanged when updating an event.
  private designConfig: Record<string, any> = {};
  private customFields: any[] = [];

  @ViewChild('descEditor') descEditor?: ElementRef<HTMLDivElement>;
  loading = false;
  saving = false;
  successMessage = '';
  errorMessage = '';
  draftRestored = false;
  private draftTimer: ReturnType<typeof setTimeout> | null = null;

  get dashboardRoute(): string {
    return this.auth.isSuperAdmin() ? '/superadmin-dashboard' : '/creator-dashboard';
  }

  // ═════════════════════════════════ Lifecycle ═════════════════════════════════

  ngOnInit(): void {
    if (!this.auth.isCreator() && !this.auth.isSuperAdmin()) {
      this.router.navigate(['/events']);
      return;
    }
    this.loadCategories();

    const id = this.route.snapshot.paramMap.get('id') || this.route.snapshot.queryParamMap.get('id');
    if (id) {
      this.isEdit = true;
      this.eventId = id;
      this.loadEvent(id);
    } else {
      this.startDate = this.endDate = this.isoDay(0);
      this.restoreDraft();
    }
  }

  ngAfterViewInit(): void {
    this.syncEditorFromDescription();
  }

  ngOnDestroy(): void {
    if (this.draftTimer) clearTimeout(this.draftTimer);
  }

  // ═════════════════════════════════ Categories ═════════════════════════════════

  loadCategories(): void {
    this.es.getCategories().subscribe({
      next: (list: string[]) => {
        const real = (Array.isArray(list) ? list : []).filter((c) => c.toLowerCase() !== 'movie');
        this.categories = real.length ? real : [...this.defaultCategories];
        this.applyCategory(this.resolvedCategory);
      },
      error: () => (this.categories = [...this.defaultCategories]),
    });
  }

  emojiFor(category: string): string {
    return this.categoryEmoji[category.toLowerCase()] || '✨';
  }

  pickCategory(value: string): void {
    this.category = value;
    this.changed();
  }

  get resolvedCategory(): string {
    return this.category === this.customCategoryValue ? this.customCategory.trim() : this.category;
  }

  private applyCategory(value: string): void {
    if (!value) return;
    if (this.categories.some((c) => c.toLowerCase() === value.toLowerCase())) {
      this.category = this.categories.find((c) => c.toLowerCase() === value.toLowerCase())!;
      this.customCategory = '';
    } else if (this.categories.length) {
      this.category = this.customCategoryValue;
      this.customCategory = value;
    }
  }

  // ═════════════════════════════════ Steps & validation ═════════════════════════════════

  /** Missing or invalid fields per step, in the order they appear on screen. */
  problems(step: CreateEventStep): string[] {
    const out: string[] = [];
    if (step === 'basics') {
      if (!this.title.trim()) out.push('Add an event name');
      if (!this.resolvedCategory) out.push('Pick a category');
    }
    if (step === 'schedule') {
      if (this.locationMode === 'Offline' && !this.venue.trim()) out.push('Add the venue');
      if (this.locationMode === 'Online' && !/^https?:\/\/\S+$/i.test(this.meetingLink.trim())) out.push('Add a valid meeting link (https://…)');
      if (!this.startDate) out.push('Pick a date');
      if (this.multiDay && (!this.endDate || this.endDate < this.startDate)) out.push('End date must be on or after the start date');
      if (!this.validTimes.length) out.push('Add at least one show time');
      else if (this.startDate === this.isoDay(0) && !this.multiDay && this.validTimes.every((t) => t <= this.nowHHmm())) {
        out.push('All of today’s show times have passed — add a later time');
      }
    }
    if (step === 'tickets') {
      if (!this.isFree && !(Number(this.price) > 0)) out.push('Set a ticket price (or make it free)');
      if (!(Number(this.totalSeats) >= 1) || Number(this.totalSeats) > 2000) out.push('Seats per show must be between 1 and 2000');
    }
    if (step === 'publish') {
      if (!this.selectedFile && !this.existingImageUrl) out.push('Upload a poster or banner');
    }
    return out;
  }

  isComplete(step: CreateEventStep): boolean {
    return this.problems(step).length === 0;
  }

  showProblems(step: CreateEventStep): boolean {
    return this.attempted.has(step) && !this.isComplete(step);
  }

  /** Highlight a field once the creator has tried to move past its step. */
  invalid(step: CreateEventStep, check: boolean): boolean {
    return this.attempted.has(step) && check;
  }

  get stepIndex(): number {
    return this.steps.findIndex((s) => s.key === this.step);
  }

  get readyToPublish(): boolean {
    return this.steps.every((s) => this.isComplete(s.key));
  }

  get completion(): number {
    return Math.round((this.steps.filter((s) => this.isComplete(s.key)).length / this.steps.length) * 100);
  }

  goTo(step: CreateEventStep): void {
    // Going back is always allowed; going forward needs every earlier step to be complete.
    const target = this.steps.findIndex((s) => s.key === step);
    for (let i = 0; i < target; i++) {
      if (!this.isComplete(this.steps[i].key)) {
        this.attempted.add(this.steps[i].key);
        this.setStep(this.steps[i].key);
        return;
      }
    }
    this.setStep(step);
  }

  next(): void {
    this.attempted.add(this.step);
    if (!this.isComplete(this.step)) return;
    const nextStep = this.steps[this.stepIndex + 1];
    if (nextStep) this.setStep(nextStep.key);
  }

  back(): void {
    const prev = this.steps[this.stepIndex - 1];
    if (prev) this.setStep(prev.key);
  }

  /** ✓ in the stepper: complete, and either opened already or (when editing) prefilled. */
  isDone(step: CreateEventStep): boolean {
    return this.isComplete(step) && (this.visited.has(step) || this.isEdit);
  }

  private setStep(step: CreateEventStep): void {
    this.step = step;
    this.visited.add(step);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // ═════════════════════════════════ Dates & show times ═════════════════════════════════

  get today(): string {
    return this.isoDay(0);
  }

  private isoDay(offset: number, from?: Date): string {
    const d = from ? new Date(from) : new Date();
    d.setDate(d.getDate() + offset);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  private nowHHmm(): string {
    const d = new Date();
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  quickDate(kind: 'today' | 'tomorrow' | 'weekend' | 'week'): void {
    if (kind === 'today' || kind === 'tomorrow') {
      this.multiDay = false;
      this.startDate = this.endDate = this.isoDay(kind === 'today' ? 0 : 1);
    } else if (kind === 'weekend') {
      const now = new Date();
      const toSat = (6 - now.getDay() + 7) % 7;
      this.multiDay = true;
      this.startDate = this.isoDay(toSat);
      this.endDate = this.isoDay(toSat + 1);
    } else {
      this.multiDay = true;
      this.startDate = this.isoDay(0);
      this.endDate = this.isoDay(6);
    }
    this.changed();
  }

  setMultiDay(value: boolean): void {
    this.multiDay = value;
    if (!value) this.endDate = this.startDate;
    else if (!this.endDate || this.endDate <= this.startDate) this.endDate = this.startDate ? this.isoDay(1, new Date(`${this.startDate}T00:00:00`)) : '';
    this.changed();
  }

  onStartDateChange(): void {
    if (!this.multiDay || !this.endDate || this.endDate < this.startDate) this.endDate = this.startDate;
    this.changed();
  }

  get validTimes(): string[] {
    return [...new Set(this.showTimes.filter((t) => TIME_RE.test(t)))].sort();
  }

  hasTime(t: string): boolean {
    return this.showTimes.includes(t);
  }

  toggleTime(t: string): void {
    this.showTimes = this.hasTime(t) ? this.showTimes.filter((x) => x !== t) : [...this.showTimes, t].sort();
    this.changed();
  }

  addCustomTime(): void {
    const t = (this.newTime || '').trim();
    if (!TIME_RE.test(t)) return;
    if (!this.hasTime(t)) this.showTimes = [...this.showTimes, t].sort();
    this.newTime = '';
    this.changed();
  }

  removeTime(t: string): void {
    this.showTimes = this.showTimes.filter((x) => x !== t);
    this.changed();
  }

  formatTime(hhmm: string): string {
    const [h, m] = hhmm.split(':').map(Number);
    return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
  }

  private formatDay(iso: string, withYear = false): string {
    const d = new Date(`${iso}T00:00:00`);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', ...(withYear ? { year: 'numeric' } : {}) });
  }

  get dayCount(): number {
    if (!this.startDate) return 0;
    if (!this.multiDay || !this.endDate) return 1;
    const ms = new Date(`${this.endDate}T00:00:00`).getTime() - new Date(`${this.startDate}T00:00:00`).getTime();
    return ms >= 0 ? Math.round(ms / 86400000) + 1 : 0;
  }

  get dateLabel(): string {
    if (!this.startDate) return 'Date';
    if (!this.multiDay || this.endDate === this.startDate) return this.formatDay(this.startDate, true);
    return `${this.formatDay(this.startDate)} – ${this.formatDay(this.endDate, true)}`;
  }

  get timesLabel(): string {
    return this.validTimes.map((t) => this.formatTime(t)).join(' · ') || 'Show time';
  }

  get totalShows(): number {
    return this.dayCount * this.validTimes.length;
  }

  // ═════════════════════════════════ Tickets ═════════════════════════════════

  setFree(value: boolean): void {
    this.isFree = value;
    if (!value && !(Number(this.price) > 0)) this.price = 499;
    this.changed();
  }

  get priceLabel(): string {
    return this.isFree ? 'Free' : `₹${Number(this.price || 0).toLocaleString('en-IN')}`;
  }

  /** Same layout rule as the backend's seat map (seat-map.util.js). */
  get seatLayout(): { rows: number; perRow: number } {
    const total = Math.max(0, Number(this.totalSeats) || 0);
    const perRow = total <= 60 ? 10 : total <= 200 ? 15 : 20;
    return { rows: Math.ceil(total / perRow), perRow };
  }

  get revenuePerShow(): string {
    if (this.isFree) return '₹0';
    const value = Number(this.price || 0) * Number(this.totalSeats || 0);
    return `₹${value.toLocaleString('en-IN')}`;
  }

  // ═════════════════════════════════ Poster ═════════════════════════════════

  getImageUrl(path: string | null): string {
    if (!path) return '';
    if (path.startsWith('http') || path.startsWith('data:')) return path;
    const clean = path.startsWith('/') ? path.substring(1) : path;
    return `${environment.apiUrl}/${clean}`;
  }

  get posterUrl(): string {
    return this.imagePreviewUrl || this.getImageUrl(this.existingImageUrl);
  }

  onFileSelected(evt: Event): void {
    const input = evt.target as HTMLInputElement;
    const file = input?.files?.[0];
    if (file) this.useFile(file);
    if (input) input.value = '';
  }

  onDrop(evt: DragEvent): void {
    evt.preventDefault();
    this.dragOver = false;
    const file = evt.dataTransfer?.files?.[0];
    if (file) this.useFile(file);
  }

  onDragOver(evt: DragEvent): void {
    evt.preventDefault();
    this.dragOver = true;
  }

  removePoster(): void {
    this.selectedFile = null;
    this.imagePreviewUrl = null;
  }

  private useFile(file: File): void {
    this.errorMessage = '';
    if (!/^image\/(png|jpe?g|webp)$/.test(file.type)) {
      this.errorMessage = 'Please upload a JPG, PNG or WebP image.';
      return;
    }
    if (file.size > this.maxImageBytes) {
      this.errorMessage = 'The image must be under 5 MB.';
      return;
    }
    this.resizeImage(file, 1200, 800)
      .then(({ resizedFile, previewUrl }) => {
        this.selectedFile = resizedFile;
        this.imagePreviewUrl = previewUrl;
      })
      .catch(() => (this.errorMessage = 'Could not read that image. Please try another one.'));
  }

  /** Crop to a 3:2 banner and compress, so uploads stay small and posters look consistent. */
  private resizeImage(file: File, targetW: number, targetH: number): Promise<{ resizedFile: File; previewUrl: string }> {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = targetW;
        canvas.height = targetH;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          URL.revokeObjectURL(url);
          reject(new Error('Canvas not supported'));
          return;
        }
        const scale = Math.max(targetW / img.width, targetH / img.height);
        const w = img.width * scale;
        const h = img.height * scale;
        ctx.drawImage(img, (targetW - w) / 2, (targetH - h) / 2, w, h);
        URL.revokeObjectURL(url);
        canvas.toBlob(
          (blob) => {
            if (!blob) return reject(new Error('Blob failed'));
            const name = `${file.name.replace(/\.[^/.]+$/, '')}-1200x800.jpg`;
            resolve({ resizedFile: new File([blob], name, { type: 'image/jpeg' }), previewUrl: canvas.toDataURL('image/jpeg', 0.85) });
          },
          'image/jpeg',
          0.85
        );
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('Image load failed'));
      };
      img.src = url;
    });
  }

  // ═════════════════════════════════ Description editor ═════════════════════════════════

  onDescriptionInput(event: Event): void {
    this.description = (event.target as HTMLElement)?.innerHTML || '';
    this.changed();
  }

  format(command: 'bold' | 'italic' | 'underline' | 'insertUnorderedList' | 'removeFormat'): void {
    this.descEditor?.nativeElement?.focus();
    document.execCommand(command, false);
    this.description = this.descEditor?.nativeElement.innerHTML || '';
    this.changed();
  }

  /** Pasted text keeps line breaks but drops foreign styling (fonts, colours, scripts). */
  onPaste(event: ClipboardEvent): void {
    event.preventDefault();
    const text = event.clipboardData?.getData('text/plain') || '';
    document.execCommand('insertText', false, text);
  }

  get descriptionLength(): number {
    return this.plainText(this.description).length;
  }

  plainText(html: string): string {
    return String(html || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
  }

  private syncEditorFromDescription(): void {
    const el = this.descEditor?.nativeElement;
    if (el && el.innerHTML !== (this.description || '')) el.innerHTML = this.description || '';
  }

  // ═════════════════════════════════ Draft (new events only) ═════════════════════════════════

  /** Called after every edit: the draft is saved shortly after the creator stops typing. */
  changed(): void {
    if (this.isEdit) return;
    if (this.draftTimer) clearTimeout(this.draftTimer);
    this.draftTimer = setTimeout(() => this.saveDraft(), 600);
  }

  private saveDraft(): void {
    const draft: Record<string, unknown> = {};
    for (const key of DRAFT_FIELDS) draft[key] = (this as any)[key];
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
    } catch {
      // Storage full or blocked: the draft is a convenience only.
    }
  }

  private restoreDraft(): void {
    let draft: Record<string, any> | null = null;
    try {
      draft = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null');
    } catch {
      draft = null;
    }
    if (!draft || !String(draft['title'] || '').trim()) return;
    for (const key of DRAFT_FIELDS) {
      if (draft[key] !== undefined) (this as any)[key] = draft[key];
    }
    if (this.startDate && this.startDate < this.today) this.startDate = this.today;
    if (this.endDate && this.endDate < this.startDate) this.endDate = this.startDate;
    this.draftRestored = true;
  }

  discardDraft(): void {
    try {
      localStorage.removeItem(DRAFT_KEY);
    } catch {
      // ignore
    }
    window.location.reload();
  }

  // ═════════════════════════════════ Load (edit) ═════════════════════════════════

  loadEvent(id: string): void {
    this.loading = true;
    this.es.getEventById(id).subscribe({
      next: (ev: any) => {
        this.title = ev.title || '';
        this.tagline = ev.tagline || '';
        this.description = ev.description || '';
        this.language = ev.language || this.language;
        this.ageRestriction = ev.ageRestriction || this.ageRestriction;
        this.applyCategory(ev.category || '');
        if (!this.categories.length) this.category = ev.category || '';

        const legacy = ev.date ? new Date(ev.date) : null;
        this.startDate = ev.startDate ? String(ev.startDate).slice(0, 10) : (ev.date ? String(ev.date).slice(0, 10) : '');
        this.endDate = ev.endDate ? String(ev.endDate).slice(0, 10) : this.startDate;
        this.multiDay = !!this.endDate && this.endDate !== this.startDate;
        if (Array.isArray(ev.showTimes) && ev.showTimes.length) {
          this.showTimes = ev.showTimes.map((t: any) => String(t || '').trim()).filter((t: string) => TIME_RE.test(t));
        } else if (legacy && !Number.isNaN(legacy.getTime())) {
          this.showTimes = [`${String(legacy.getHours()).padStart(2, '0')}:${String(legacy.getMinutes()).padStart(2, '0')}`];
        }

        this.locationMode = ev.locationType === 'Online' ? 'Online' : 'Offline';
        this.meetingLink = ev.meetingLink || (this.locationMode === 'Online' ? ev.venue || '' : '');
        this.venue = this.locationMode === 'Offline' ? ev.venue || '' : '';
        this.price = Number(ev.price) || 0;
        this.isFree = this.price === 0;
        if (this.isFree) this.price = null;
        this.totalSeats = Number(ev.totalSeats) || 1;
        this.existingImageUrl = ev.imageUrl || null;
        this.designConfig = ev.designConfig && typeof ev.designConfig === 'object' ? ev.designConfig : {};
        this.themeColor = this.designConfig['themeColor'] || this.themeColor;
        this.customFields = Array.isArray(ev.customFields) ? ev.customFields : [];
        // Editing an existing event: every step is reachable and validated right away.
        this.steps.forEach((s) => this.attempted.add(s.key));
        this.syncEditorFromDescription();
        this.loading = false;
      },
      error: () => {
        this.errorMessage = 'Could not load this event. Please go back and try again.';
        this.loading = false;
      },
    });
  }

  // ═════════════════════════════════ Submit ═════════════════════════════════

  /** The public page layout follows the category. */
  private get designTemplate(): string {
    const c = this.resolvedCategory.toLowerCase();
    if (c.includes('movie')) return 'movie';
    if (c.includes('concert') || c.includes('music')) return 'concert';
    if (c.includes('comedy')) return 'comedy';
    return 'clean-hero';
  }

  submit(): void {
    this.errorMessage = '';
    this.successMessage = '';
    this.steps.forEach((s) => this.attempted.add(s.key));
    const firstIncomplete = this.steps.find((s) => !this.isComplete(s.key));
    if (firstIncomplete) {
      this.errorMessage = `Almost there — ${this.problems(firstIncomplete.key)[0].toLowerCase()}.`;
      this.setStep(firstIncomplete.key);
      return;
    }

    const times = this.validTimes;
    const firstShow = new Date(`${this.startDate}T${times[0]}:00`);
    const endDate = this.multiDay ? this.endDate : this.startDate;
    const online = this.locationMode === 'Online';
    const price = this.isFree ? 0 : Number(this.price);

    const fd = new FormData();
    fd.append('title', this.title.trim());
    fd.append('tagline', this.tagline.trim());
    fd.append('description', this.description.trim());
    fd.append('category', this.resolvedCategory);
    fd.append('language', this.language);
    fd.append('ageRestriction', this.ageRestriction);
    fd.append('date', firstShow.toISOString());
    fd.append('startDate', this.startDate);
    fd.append('endDate', endDate);
    fd.append('showTimes', JSON.stringify(times));
    fd.append('locationType', this.locationMode);
    fd.append('venue', online ? 'Online' : this.venue.trim());
    fd.append('meetingLink', online ? this.meetingLink.trim() : '');
    fd.append('price', String(price));
    fd.append('totalSeats', String(Math.round(Number(this.totalSeats))));
    fd.append('designTemplate', this.designTemplate);
    fd.append('designConfig', JSON.stringify({ ...this.designConfig, themeColor: this.themeColor }));
    fd.append('customFields', JSON.stringify(this.customFields));
    if (this.selectedFile) fd.append('image', this.selectedFile);

    this.saving = true;
    const request$ = this.isEdit && this.eventId ? this.es.updateEvent(this.eventId, fd) : this.es.createEvent(fd);
    request$.subscribe({
      next: () => {
        this.saving = false;
        if (!this.isEdit) {
          try {
            localStorage.removeItem(DRAFT_KEY);
          } catch {
            // ignore
          }
        }
        this.successMessage = this.isEdit ? 'Changes saved! Taking you to your dashboard…' : 'Your event is live! 🎉 Taking you to your dashboard…';
        setTimeout(() => this.router.navigate([this.dashboardRoute]), 1200);
      },
      error: (err) => {
        this.saving = false;
        this.errorMessage = err?.error?.message || (this.isEdit ? 'Could not save your changes. Please try again.' : 'Could not publish the event. Please try again.');
      },
    });
  }
}
