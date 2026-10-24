import { AfterViewInit, Component, ElementRef, OnInit, ViewChild, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import { EventService } from '../../services/event.service';
import { AuthService } from '../../auth/auth.service';
import { environment } from '../../../environments/environment';

type CustomFieldType = 'text' | 'email' | 'phone' | 'number' | 'textarea' | 'select' | 'checkbox';
type CreateEventStep = 'basic' | 'datetime' | 'design' | 'tickets' | 'customize' | 'seo' | 'settings';

@Component({
  standalone: true,
  selector: 'app-create-event',
  imports: [CommonModule, FormsModule, RouterModule],
  templateUrl: './create-event.component.html',
  styleUrls: ['./create-event.component.css'],
})
export class CreateEventComponent implements OnInit, AfterViewInit {
  private readonly customFieldTypes: CustomFieldType[] = ['text', 'email', 'phone', 'number', 'textarea', 'select', 'checkbox'];

  private es = inject(EventService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private auth = inject(AuthService);

  isEdit = false;
  eventId: string | null = null;

  title = '';
  tagline = '';
  description = '';
  // Legacy single datetime (kept for backward compatibility; computed from schedule on submit)
  date = '';

  // New: schedule (BookMyShow-style)
  startDate = '';
  endDate = '';
  showTimes: string[] = ['19:00'];
  venue = '';
  meetingLink = '';
  price = 0;
  totalSeats = 1;
  category = '';
  customCategory = '';
  locationType = '';
  language = 'English';
  ageRestriction = 'All Ages';
  timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Kolkata';
  isMultiDate = false;
  mapQuery = '';
  registrationTemplate = 'standard';
  designTemplate = 'clean-hero';
  imagePreset = 'preset-a';
  bannerFile: File | null = null;
  thumbnailFile: File | null = null;
  readonly customCategoryValue = '__custom__';
  categories: string[] = [];
  private readonly defaultCategories = ['Conference', 'Workshop', 'Seminar', 'Concert', 'Webinar', 'Movie', 'Comedy', 'Sports'];
  readonly fontOptions = ['Space Grotesk', 'Georgia', 'Courier New', 'Arial'];
  readonly fontSizes = [10,12, 14, 16, 18, 20, 24, 28];
  selectedFont = 'Arial';
  selectedFontSize = 16;
  selectedColor = '#e5e7eb';
  designConfig = {
    badgeText: 'Book Now',
    heroKicker: 'Live Event',
    ctaText: 'Book Tickets',
    themeColor: '#6d28d9',
    overlayColor: '#0f172a',
    overlayOpacity: 55,
    gradientOverlay: true,
    textAlign: 'left' as 'left' | 'center' | 'right',
    buttonStyle: 'solid' as 'solid' | 'outline' | 'rounded',
    darkMode: false,
    showLogo: false,
    showWatermark: false,
  };
  previewMode: 'desktop' | 'mobile' = 'desktop';
  ticketMode: 'free' | 'paid' | 'donation' = 'paid';
  earlyBirdEnabled = false;
  discountCodesEnabled = false;
  tieredPricingEnabled = false;
  speakersEnabled = true;
  agendaEnabled = true;
  faqsEnabled = true;
  sponsorsEnabled = false;
  customSections: Array<{ title: string; body: string }> = [];
  customSectionDraft = { title: '', body: '' };
  slug = '';
  metaTitle = '';
  metaDescription = '';
  socialPreviewImage = '';
  visibility: 'Public' | 'Private' | 'Unlisted' = 'Public';
  approvalRequired = false;
  refundPolicy = '';
  termsText = '';
  customFields: Array<{
    label: string;
    type: CustomFieldType;
    required: boolean;
    options?: string[];
  }> = [];
  customFieldDraft = {
    label: '',
    type: 'text' as CustomFieldType,
    required: false,
    optionsText: '',
  };
  customFieldError = '';

  selectedFile: File | null = null;
  imagePreviewUrl: string | null = null;
  existingImageUrl: string | null = null;
  selectedCreateStep: CreateEventStep = 'basic';
  @ViewChild('descEditor') descEditor?: ElementRef<HTMLDivElement>;
  loading = false;
  successMessage = '';
  errorMessage = '';
  private readonly maxImageBytes = 5 * 1024 * 1024;
  private readonly imageWidth = 1200;
  private readonly imageHeight = 800;

  private get dashboardRoute(): string {
    return this.auth.isSuperAdmin() ? '/superadmin-dashboard' : '/creator-dashboard';
  }

  // =============================
  // INIT
  // =============================
  ngOnInit(): void {

    this.loadCategories();

    if (!this.auth.isCreator() && !this.auth.isSuperAdmin()) {
      this.router.navigate(['/events']);
      return;
    }

    const id =
      this.route.snapshot.paramMap.get('id') ||
      this.route.snapshot.queryParamMap.get('id');
    if (id) {
      this.isEdit = true;
      this.eventId = id;
      this.loadEvent(id);
    }
  }

    // =============================
  // CATEGORIES
  // =============================
  loadCategories() {
    this.es.getCategories().subscribe({
      next: (list: string[]) => {
        this.categories = Array.isArray(list) && list.length ? list : [...this.defaultCategories];
      },
      error: () => {
        this.categories = [...this.defaultCategories];
      }
    });
  }
  // =============================
  // IMAGE URL FIX (for prod/local)
  // =============================
  getImageUrl(path: string | null): string {
    if (!path) return '';
    if (path.startsWith('http')) return path;

    const clean = path.startsWith('/') ? path.substring(1) : path;
    return `${environment.apiUrl}/${clean}`;
  }

  // =============================
  // MIN DATE (Schedule)
  // =============================
  get minDateLocal(): string {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  // =============================
  // SCHEDULE PREVIEW
  // =============================
  get schedulePreview(): { rangeText: string; timesText: string } | null {
    if (!this.startDate || !this.endDate || !this.showTimes?.length) return null;

    const s = new Date(`${this.startDate}T00:00:00`);
    const e = new Date(`${this.endDate}T00:00:00`);
    if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return null;

    const fmt = new Intl.DateTimeFormat('en-GB', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    });

    const rangeText =
      this.startDate === this.endDate
        ? fmt.format(s)
        : `${fmt.format(s)} - ${fmt.format(e)}`;

    const timesText = this.showTimes
      .map((t) => String(t || '').trim())
      .filter(Boolean)
      .join(', ');

    return timesText ? { rangeText, timesText } : null;
  }

  // Legacy preview helper used by existing preview UI (derived from schedule)
  get datePreview(): { dateText: string; timeText: string } | null {
    const iso = this.buildLegacyDateIso() || (this.date ? new Date(this.date).toISOString() : '');
    if (!iso) return null;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;

    const dateText = new Intl.DateTimeFormat('en-GB', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    }).format(d);

    const timeText = new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(d);

    return { dateText, timeText };
  }

  private buildLegacyDateIso(): string {
    const firstTime = String(this.showTimes?.[0] || '').trim();
    if (!this.startDate || !firstTime) return '';
    // Local date + time -> ISO (keeps correct moment for current user timezone)
    const d = new Date(`${this.startDate}T${firstTime}:00`);
    if (Number.isNaN(d.getTime())) return '';
    return d.toISOString();
  }

  addShowTime() {
    this.showTimes = [...(this.showTimes || []), '19:00'];
  }

  removeShowTime(index: number) {
    const next = [...(this.showTimes || [])];
    next.splice(index, 1);
    this.showTimes = next.length ? next : ['19:00'];
  }

  // =============================
  // FILE SELECT
  // =============================
  onFileSelected(evt: Event): void {
    const input = evt.target as HTMLInputElement;
    const file = input?.files?.[0];

    if (!file) return;

    this.errorMessage = '';

    if (!file.type.startsWith('image/')) {
      this.errorMessage = 'Only image files are allowed.';
      input.value = '';
      return;
    }

    if (file.size > this.maxImageBytes) {
      this.errorMessage = 'Image size must be under 5MB.';
      input.value = '';
      return;
    }

    this.resizeImage(file, this.imageWidth, this.imageHeight)
      .then(({ resizedFile, previewUrl }) => {
        this.selectedFile = resizedFile;
        this.imagePreviewUrl = previewUrl;
      })
      .catch(() => {
        this.errorMessage = 'Failed to process image.';
        input.value = '';
      });
  }

  readonly createSteps: Array<{ key: CreateEventStep; title: string; meta: string }> = [
    { key: 'basic', title: 'Basic', meta: 'Identity and copy' },
    { key: 'datetime', title: 'Date', meta: 'Time and location' },
    { key: 'design', title: 'Design', meta: 'Banner and visuals' },
    { key: 'tickets', title: 'Tickets', meta: 'Pricing and limits' },
    { key: 'customize', title: 'Customize', meta: 'Sections and content' },
    { key: 'seo', title: 'SEO', meta: 'Slug and sharing' },
    { key: 'settings', title: 'Settings', meta: 'Visibility and rules' },
  ];

  selectCreateStep(key: CreateEventStep) {
    if (!this.canOpenStep(key)) return;
    this.selectedCreateStep = key;
  }

  goNextStep() {
    if (this.selectedCreateStep === 'basic' && this.canProceedBasic) {
      this.selectedCreateStep = 'datetime';
      return;
    }
    if (this.selectedCreateStep === 'datetime' && this.canProceedDateTime) {
      this.selectedCreateStep = 'design';
      return;
    }
    if (this.selectedCreateStep === 'design' && this.canProceedDesign) {
      this.selectedCreateStep = 'tickets';
      return;
    }
    if (this.selectedCreateStep === 'tickets' && this.canProceedTickets) {
      this.selectedCreateStep = 'customize';
      return;
    }
    if (this.selectedCreateStep === 'customize' && this.canProceedCustomize) {
      this.selectedCreateStep = 'seo';
      return;
    }
    if (this.selectedCreateStep === 'seo' && this.canProceedSeo) {
      this.selectedCreateStep = 'settings';
    }
  }

  ngAfterViewInit(): void {
    this.syncEditorFromDescription();
  }

  goPrevStep() {
    if (this.selectedCreateStep === 'settings') { this.selectedCreateStep = 'seo'; return; }
    if (this.selectedCreateStep === 'seo') { this.selectedCreateStep = 'customize'; return; }
    if (this.selectedCreateStep === 'customize') { this.selectedCreateStep = 'tickets'; return; }
    if (this.selectedCreateStep === 'tickets') { this.selectedCreateStep = 'design'; return; }
    if (this.selectedCreateStep === 'design') { this.selectedCreateStep = 'datetime'; return; }
    if (this.selectedCreateStep === 'datetime') { this.selectedCreateStep = 'basic'; return; }
  }

  get canProceedBasic(): boolean {
    return !!(this.title.trim() && this.resolvedCategory && this.language && this.ageRestriction);
  }

  get canProceedDateTime(): boolean {
    return !!(
      this.startDate &&
      this.endDate &&
      this.showTimes?.length &&
      this.showTimes.some((time) => String(time || '').trim()) &&
      this.locationType &&
      ((this.locationType === 'Online' && this.meetingLink.trim()) || (this.locationType !== 'Online' && this.venue.trim()))
    );
  }

  get canProceedTickets(): boolean {
    return !!(this.totalSeats >= 1 && this.price >= 0 && this.registrationTemplate && this.ticketMode);
  }

  get canProceedDesign(): boolean {
    return !!(this.designTemplate && (this.selectedFile || this.existingImageUrl));
  }

  get canProceedCustomize(): boolean {
    return true;
  }

  get canProceedSeo(): boolean {
    return !!(this.slug.trim() || this.title.trim());
  }

  get canPublish(): boolean {
    return this.canProceedBasic && this.canProceedDateTime && this.canProceedDesign && this.canProceedTickets && this.canProceedCustomize && this.canProceedSeo;
  }

  canOpenStep(step: CreateEventStep): boolean {
    if (step === 'basic') return true;
    if (step === 'datetime') return this.canProceedBasic;
    if (step === 'design') return this.canProceedBasic && this.canProceedDateTime;
    if (step === 'tickets') return this.canProceedBasic && this.canProceedDateTime && this.canProceedDesign;
    if (step === 'customize') return this.canProceedBasic && this.canProceedDateTime && this.canProceedDesign && this.canProceedTickets;
    if (step === 'seo') return this.canProceedBasic && this.canProceedDateTime && this.canProceedDesign && this.canProceedTickets && this.canProceedCustomize;
    return this.canPublish;
  }

  isStepComplete(step: CreateEventStep): boolean {
    if (step === 'basic') return this.canProceedBasic;
    if (step === 'datetime') return this.canProceedDateTime;
    if (step === 'design') return this.canProceedDesign;
    if (step === 'tickets') return this.canProceedTickets;
    if (step === 'customize') return this.canProceedCustomize;
    if (step === 'seo') return this.canProceedSeo;
    return this.canPublish;
  }

  get currentStepIndex(): number {
    return this.createSteps.findIndex((step) => step.key === this.selectedCreateStep);
  }

  get completionCount(): number {
    return this.createSteps.filter((step) => this.isStepComplete(step.key)).length;
  }

  get completionPercent(): number {
    return Math.round((this.completionCount / this.createSteps.length) * 100);
  }

  get priceLabel(): string {
    return Number(this.price || 0) === 0 ? 'Free' : `Rs ${this.price}`;
  }

  get imageStatusLabel(): string {
    return this.selectedFile ? this.selectedFile.name : (this.existingImageUrl ? 'Current cover ready' : 'No cover selected');
  }

  get previewVenue(): string {
    if (this.locationType === 'Online') return this.meetingLink || 'Online event link';
    return this.venue || 'Venue will appear here';
  }

  get ticketSummary(): string {
    if (this.ticketMode === 'free') return 'Free entry';
    if (this.ticketMode === 'donation') return 'Donation based';
    return this.priceLabel;
  }

  // =============================
  // LOAD EVENT (EDIT MODE)
  // =============================
  loadEvent(id: string) {
    this.loading = true;

    this.es.getEventById(id).subscribe({
      next: (ev: any) => {
        this.title = ev.title || '';
        this.tagline = ev.tagline || '';
        this.description = ev.description || '';
        this.syncEditorFromDescription();
        // Schedule (new) with fallbacks to legacy `date`
        const legacyIso = ev.date || '';
        const legacyDate = legacyIso ? new Date(legacyIso) : null;

        this.startDate = ev.startDate ? String(ev.startDate).slice(0, 10) : (legacyIso ? legacyIso.slice(0, 10) : '');
        this.endDate = ev.endDate ? String(ev.endDate).slice(0, 10) : this.startDate;

        if (Array.isArray(ev.showTimes) && ev.showTimes.length) {
          this.showTimes = ev.showTimes.map((t: any) => String(t || '').trim()).filter(Boolean);
        } else if (legacyDate && !Number.isNaN(legacyDate.getTime())) {
          const hh = String(legacyDate.getHours()).padStart(2, '0');
          const mm = String(legacyDate.getMinutes()).padStart(2, '0');
          this.showTimes = [`${hh}:${mm}`];
        } else {
          this.showTimes = ['19:00'];
        }

        // Keep legacy date field (not shown in UI)
        this.date = legacyIso ? legacyIso.slice(0, 16) : '';
        this.venue = ev.venue || '';
        this.meetingLink = ev.meetingLink || '';
        this.price = ev.price || 0;
        this.totalSeats = ev.totalSeats || 1;
        this.existingImageUrl = ev.imageUrl || null;
        this.applyCategory(ev.category || '');
        this.locationType = ev.locationType || '';
        this.language = ev.language || this.language;
        this.ageRestriction = ev.ageRestriction || this.ageRestriction;
        this.timezone = ev.timezone || this.timezone;
        this.isMultiDate = !!ev.isMultiDate;
        this.mapQuery = ev.mapQuery || '';
        this.registrationTemplate = ev.registrationTemplate || this.registrationTemplate;
        this.designTemplate = ev.designTemplate || this.designTemplate;
        this.imagePreset = ev.imagePreset || this.imagePreset;
        this.ticketMode = ev.ticketMode || this.ticketMode;
        this.slug = ev.slug || '';
        this.metaTitle = ev.metaTitle || '';
        this.metaDescription = ev.metaDescription || '';
        this.socialPreviewImage = ev.socialPreviewImage || '';
        this.visibility = ev.visibility || this.visibility;
        this.approvalRequired = !!ev.approvalRequired;
        this.refundPolicy = ev.refundPolicy || '';
        this.termsText = ev.termsText || '';
        this.customSections = Array.isArray(ev.customSections) ? ev.customSections : [];
        this.customFields = Array.isArray(ev.customFields) ? ev.customFields : [];
        if (ev.designConfig && typeof ev.designConfig === 'object') {
          this.designConfig = {
            ...this.designConfig,
            ...ev.designConfig
          };
        }
      },
      error: () => this.errorMessage = 'Failed to load event',
      complete: () => this.loading = false
    });
  }

  // =============================
  // SUBMIT
  // =============================
  submit(): void {

    if (!this.auth.isCreator() && !this.auth.isSuperAdmin()) {
      this.router.navigate(['/events']);
      return;
    }

    this.errorMessage = '';
    this.successMessage = '';

    if (!this.canPublish) {
      this.errorMessage = 'Please complete all sections before publishing.';
      return;
    }

    if (!this.title.trim()) { this.errorMessage = 'Title required'; return; }
    if (!this.resolvedCategory) { this.errorMessage = 'Category required'; return; }
    if (this.locationType === 'Online' && !this.meetingLink.trim()) { this.errorMessage = 'Meeting link required'; return; }
    if (this.locationType !== 'Online' && !this.venue.trim()) { this.errorMessage = 'Venue required'; return; }
    if (!this.startDate) { this.errorMessage = 'Start date required'; return; }
    if (!this.endDate) { this.errorMessage = 'End date required'; return; }
    if (!this.showTimes?.length) { this.errorMessage = 'At least 1 show time required'; return; }
    if (!this.locationType) { this.errorMessage = 'Location type required'; return; }
    if (this.totalSeats < 1) { this.errorMessage = 'Seats must be >= 1'; return; }
    if (this.price < 0) { this.errorMessage = 'Price cannot be negative'; return; }

    if (this.endDate < this.startDate) {
      this.errorMessage = 'End date must be after start date';
      return;
    }

    const times = this.showTimes
      .map((t) => String(t || '').trim())
      .filter(Boolean);

    const invalidTime = times.find((t) => !/^([01]\d|2[0-3]):[0-5]\d$/.test(t));
    if (invalidTime) {
      this.errorMessage = `Invalid time: ${invalidTime}`;
      return;
    }

    const legacyIso = this.buildLegacyDateIso();
    if (!legacyIso) {
      this.errorMessage = 'Invalid start date / show time';
      return;
    }

    const fd = new FormData();
    fd.append('title', this.title.trim());
    fd.append('tagline', this.tagline.trim());
    fd.append('description', this.description.trim());
    fd.append('date', legacyIso);
    fd.append('startDate', this.startDate);
    fd.append('endDate', this.endDate);
    fd.append('showTimes', JSON.stringify(times));
    fd.append('venue', this.locationType === 'Online' ? (this.meetingLink.trim() || this.venue.trim()) : this.venue.trim());
    fd.append('price', String(this.price));
    fd.append('totalSeats', String(this.totalSeats));
    fd.append('category', this.resolvedCategory);
    fd.append('locationType', this.locationType);
    fd.append('meetingLink', this.meetingLink.trim());
    fd.append('language', this.language);
    fd.append('ageRestriction', this.ageRestriction);
    fd.append('timezone', this.timezone);
    fd.append('isMultiDate', String(this.isMultiDate));
    fd.append('mapQuery', this.mapQuery.trim());
    fd.append('registrationTemplate', this.registrationTemplate);
    fd.append('designTemplate', this.designTemplate);
    fd.append('imagePreset', this.imagePreset);
    fd.append('ticketMode', this.ticketMode);
    fd.append('customSections', JSON.stringify(this.customSections));
    fd.append('slug', this.resolvedSlug);
    fd.append('metaTitle', this.metaTitle.trim());
    fd.append('metaDescription', this.metaDescription.trim());
    fd.append('socialPreviewImage', this.socialPreviewImage.trim());
    fd.append('visibility', this.visibility);
    fd.append('approvalRequired', String(this.approvalRequired));
    fd.append('refundPolicy', this.refundPolicy.trim());
    fd.append('termsText', this.termsText.trim());
    fd.append('designConfig', JSON.stringify(this.designConfig));
    fd.append('customFields', JSON.stringify(this.customFields));

    if (this.selectedFile) {
      fd.append('image', this.selectedFile);
    }

    this.loading = true;

    if (this.isEdit && this.eventId) {

      this.es.updateEvent(this.eventId, fd).subscribe({
        next: () => {
          this.successMessage = 'Event Updated Successfully';
          setTimeout(() => this.router.navigate([this.dashboardRoute]), 800);
        },
        error: err => {
          this.errorMessage = err?.error?.message || 'Update failed';
        },
        complete: () => this.loading = false
      });

    } else {

      this.es.createEvent(fd).subscribe({
        next: () => {
          this.successMessage = 'Event Created Successfully';
          setTimeout(() => this.router.navigate([this.dashboardRoute]), 800);
        },
        error: err => {
          this.errorMessage = err?.error?.message || 'Create failed';
        },
        complete: () => this.loading = false
      });

    }
  }

  private resizeImage(file: File, targetW: number, targetH: number): Promise<{ resizedFile: File; previewUrl: string }> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();

      reader.onload = () => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement('canvas');
          canvas.width = targetW;
          canvas.height = targetH;

          const ctx = canvas.getContext('2d');
          if (!ctx) {
            reject(new Error('Canvas not supported'));
            return;
          }

          const scale = Math.max(targetW / img.width, targetH / img.height);
          const drawW = img.width * scale;
          const drawH = img.height * scale;
          const dx = (targetW - drawW) / 2;
          const dy = (targetH - drawH) / 2;

          ctx.drawImage(img, dx, dy, drawW, drawH);

          canvas.toBlob(
            (blob) => {
              if (!blob) {
                reject(new Error('Blob failed'));
                return;
              }

              const resizedFile = new File(
                [blob],
                this.getResizedFileName(file.name),
                { type: 'image/jpeg' }
              );

              const previewUrl = canvas.toDataURL('image/jpeg', 0.85);
              resolve({ resizedFile, previewUrl });
            },
            'image/jpeg',
            0.85
          );
        };

        img.onerror = () => reject(new Error('Image load failed'));
        img.src = reader.result as string;
      };

      reader.onerror = () => reject(new Error('File read failed'));
      reader.readAsDataURL(file);
    });
  }

  private getResizedFileName(originalName: string) {
    const base = originalName.replace(/\.[^/.]+$/, '');
    return `${base}-1200x800.jpg`;
  }

  addCustomField() {
    this.customFieldError = '';
    const label = this.customFieldDraft.label.trim();
    if (!label) {
      this.customFieldError = 'Label is required.';
      return;
    }

    if (!this.customFieldTypes.includes(this.customFieldDraft.type)) {
      this.customFieldError = 'Invalid field type.';
      return;
    }

    let options: string[] = [];
    if (this.customFieldDraft.type === 'select') {
      options = this.customFieldDraft.optionsText
        .split(',')
        .map((o) => o.trim())
        .filter(Boolean);
      if (!options.length) {
        this.customFieldError = 'Select type requires options.';
        return;
      }
    }

    this.customFields.push({
      label,
      type: this.customFieldDraft.type,
      required: this.customFieldDraft.required,
      options: options.length ? options : undefined,
    });

    this.customFieldDraft = {
      label: '',
      type: 'text',
      required: false,
      optionsText: '',
    };
  }

  removeCustomField(index: number) {
    this.customFields.splice(index, 1);
  }


  get resolvedCategory(): string {
    if (this.category !== this.customCategoryValue) return this.category;
    return this.customCategory.trim();
  }

  get resolvedSlug(): string {
    const base = this.slug.trim() || this.title.trim();
    return base
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80);
  }

  addCustomSection() {
    const title = this.customSectionDraft.title.trim();
    const body = this.customSectionDraft.body.trim();
    if (!title || !body) return;
    this.customSections = [...this.customSections, { title, body }];
    this.customSectionDraft = { title: '', body: '' };
  }

  removeCustomSection(index: number) {
    this.customSections = this.customSections.filter((_, i) => i !== index);
  }

  private applyCategory(value: string) {
    if (!value) {
      this.category = '';
      this.customCategory = '';
      return;
    }
    if (this.categories.includes(value)) {
      this.category = value;
      this.customCategory = '';
      return;
    }
    this.category = this.customCategoryValue;
    this.customCategory = value;
  }

  onDescriptionInput(event: Event) {
    const el = event.target as HTMLElement | null;
    if (!el) return;
    this.description = el.innerHTML || '';
  }

  format(command: string, value?: string) {
    this.descEditor?.nativeElement?.focus();
    document.execCommand(command, false, value);
    this.syncDescriptionFromEditor();
  }

  setFont(font: string) {
    this.format('fontName', font);
  }

  setFontSize(size: number | string) {
    const value = typeof size === 'string' ? Number(size) : size;
    if (Number.isNaN(value)) return;
    const map = this.mapFontSize(value);
    this.format('fontSize', String(map));
  }

  setColor(color: string) {
    this.format('foreColor', color);
  }

  private syncDescriptionFromEditor() {
    const el = this.descEditor?.nativeElement;
    if (!el) return;
    this.description = el.innerHTML || '';
  }

  private syncEditorFromDescription() {
    const el = this.descEditor?.nativeElement;
    if (!el) return;
    const next = this.description || '';
    if (el.innerHTML !== next) {
      el.innerHTML = next;
    }
  }

  private mapFontSize(size: number): number {
    if (size <= 12) return 1;
    if (size <= 14) return 2;
    if (size <= 16) return 3;
    if (size <= 18) return 4;
    if (size <= 20) return 5;
    if (size <= 24) return 6;
    return 7;
  }

  get previewImageUrl(): string {
    return this.imagePreviewUrl || this.getImageUrl(this.existingImageUrl);
  }

  applyPreview() {
    // Trigger change detection for preview bindings
    this.designConfig = { ...this.designConfig };
  }
}







