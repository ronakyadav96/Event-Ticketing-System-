import { Component, Input, Output, EventEmitter, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';

export interface DateItem {
  dayName: string; // e.g. "MON"
  dateNumber: number; // e.g. 14
  month: string; // e.g. "SEP"
  fullDate: Date;
}

export interface ShowtimeSlot {
  time: string;
  badge?: string; // e.g. "GOLD", "PLAYHOUSE", "4DX"
  status: 'available' | 'filling-fast' | 'almost-full';
  price: string;
}

export interface CinemaShowtime {
  id: string;
  hallName: string;
  location: string;
  amenities: string[];
  isFavorite?: boolean;
  format: string; // e.g. "2D", "3D", "IMAX 3D"
  showtimes: ShowtimeSlot[];
}

@Component({
  standalone: true,
  selector: 'app-showtime-selector',
  imports: [CommonModule],
  templateUrl: './showtime-selector.component.html',
  styleUrls: ['./showtime-selector.component.css'],
})
export class ShowtimeSelectorComponent implements OnInit {
  @Input() movieTitle = '';
  @Input() language = '';
  @Input() runtime = '2h 30m';
  @Input() certificate = 'UA16+';
  @Input() genres: string[] = ['Action', 'Drama'];
  @Input() selectedTime = '';
  /** 'event' shows the event's own venue, dates and show times instead of the demo cinema list. */
  @Input() kind: 'movie' | 'event' = 'movie';
  @Input() venue = '';
  @Input() eventShowTimes: string[] = [];
  @Input() startDate: string | Date | null = null;
  @Input() endDate: string | Date | null = null;
  @Input() priceLabel = '';
  @Output() selectShowtime = new EventEmitter<{
    hallName: string;
    time: string;
    format: string;
    date: Date;
  }>();

  datesList: DateItem[] = [];
  selectedDateIndex = 0;

  selectedFormat = 'Hindi - 2D';
  readonly availableFormats = ['Hindi - 2D', 'Hindi - 3D', 'IMAX 3D', '4DX'];

  readonly cinemaHalls: CinemaShowtime[] = [
    {
      id: 'pvr-ambience',
      hallName: 'Gurugram Pepsi PVR Ambience',
      location: 'Ambience Mall, NH-8, Gurugram',
      amenities: ['Cancellation available', 'F&B Available', 'M-Ticket'],
      format: 'Hindi - 2D',
      showtimes: [
        { time: '09:00 AM', status: 'available', price: '₹250' },
        { time: '09:45 AM', badge: 'GOLD', status: 'filling-fast', price: '₹450' },
        { time: '10:00 AM', status: 'available', price: '₹250' },
        { time: '11:00 AM', status: 'available', price: '₹280' },
        { time: '12:05 PM', status: 'filling-fast', price: '₹300' },
        { time: '01:05 PM', status: 'available', price: '₹280' },
        { time: '02:05 PM', status: 'available', price: '₹300' },
        { time: '02:40 PM', badge: 'PLAYHOUSE', status: 'available', price: '₹350' },
        { time: '03:10 PM', status: 'filling-fast', price: '₹320' },
        { time: '04:10 PM', status: 'available', price: '₹320' },
        { time: '04:30 PM', badge: 'GOLD', status: 'filling-fast', price: '₹550' },
        { time: '05:10 PM', status: 'available', price: '₹350' },
        { time: '06:15 PM', status: 'filling-fast', price: '₹380' },
        { time: '07:15 PM', status: 'filling-fast', price: '₹380' },
        { time: '08:15 PM', status: 'almost-full', price: '₹380' },
        { time: '09:20 PM', status: 'available', price: '₹350' },
        { time: '10:20 PM', status: 'available', price: '₹320' },
        { time: '10:55 PM', badge: 'GOLD', status: 'filling-fast', price: '₹500' },
      ],
    },
    {
      id: 'pvr-mgf',
      hallName: 'HDFC Millennia PVR: MGF, Gurugram',
      location: 'MGF Metropolitan Mall, MG Road, Gurugram',
      amenities: ['Cancellation available', 'M-Ticket'],
      format: 'Hindi - 2D',
      showtimes: [
        { time: '10:15 AM', status: 'available', price: '₹230' },
        { time: '01:30 PM', status: 'available', price: '₹260' },
        { time: '04:45 PM', badge: 'GOLD', status: 'filling-fast', price: '₹480' },
        { time: '08:00 PM', status: 'filling-fast', price: '₹320' },
        { time: '10:45 PM', status: 'available', price: '₹260' },
      ],
    },
    {
      id: 'cinepolis-airia',
      hallName: 'Cinepolis: Airia Mall, Gurugram',
      location: 'Sector 68, Sohna Road, Gurugram',
      amenities: ['Cancellation available', 'Recliner Seats', 'F&B Available'],
      format: 'Hindi - 2D',
      showtimes: [
        { time: '11:15 AM', status: 'available', price: '₹220' },
        { time: '02:30 PM', status: 'filling-fast', price: '₹260' },
        { time: '05:45 PM', badge: 'MACRO XE', status: 'filling-fast', price: '₹350' },
        { time: '09:00 PM', status: 'almost-full', price: '₹320' },
      ],
    },
  ];

  eventHall: CinemaShowtime | null = null;

  ngOnInit(): void {
    this.generateUpcomingDates();
    if (this.kind === 'event') this.buildEventHall();
  }

  /** Halls to list: the demo cinemas for movies, the event's own venue otherwise. */
  get halls(): CinemaShowtime[] {
    return this.kind === 'event' && this.eventHall ? [this.eventHall] : this.cinemaHalls;
  }

  private buildEventHall(): void {
    const times = (this.eventShowTimes || []).filter(Boolean);
    this.eventHall = {
      id: 'venue',
      hallName: this.venue || 'Venue',
      location: this.venue || '',
      amenities: [],
      format: '',
      showtimes: (times.length ? times : ['18:00']).map((t) => ({
        time: this.to12h(t),
        status: 'available' as const,
        price: this.priceLabel,
      })),
    };

    // Only offer dates inside the event's run, starting today, at most a week out.
    const dayMs = 24 * 60 * 60 * 1000;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const start = this.startDate ? new Date(this.startDate) : today;
    const end = this.endDate ? new Date(this.endDate) : start;
    start.setHours(0, 0, 0, 0);
    end.setHours(0, 0, 0, 0);
    const first = start > today ? start : today;
    const inRun = this.datesListFrom(first, 8).filter((d) => d.fullDate.getTime() <= end.getTime() + dayMs - 1);
    this.datesList = inRun.length ? inRun : this.datesListFrom(first, 1);
    this.selectedDateIndex = 0;
  }

  private datesListFrom(first: Date, count: number): DateItem[] {
    const days = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
    const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
    return Array.from({ length: count }, (_, i) => {
      const d = new Date(first);
      d.setDate(first.getDate() + i);
      return { dayName: days[d.getDay()], dateNumber: d.getDate(), month: months[d.getMonth()], fullDate: d };
    });
  }

  /** "21:00" -> "09:00 PM"; already formatted values pass through. */
  to12h(t: string): string {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(t).trim());
    if (!m) return t;
    const h = Number(m[1]);
    const suffix = h >= 12 ? 'PM' : 'AM';
    return `${String(h % 12 || 12).padStart(2, '0')}:${m[2]} ${suffix}`;
  }

  generateUpcomingDates(): void {
    const days = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
    const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
    const list: DateItem[] = [];

    const now = new Date();
    for (let i = 0; i < 8; i++) {
      const d = new Date(now.getTime() + i * 24 * 60 * 60 * 1000);
      list.push({
        dayName: days[d.getDay()],
        dateNumber: d.getDate(),
        month: months[d.getMonth()],
        fullDate: d,
      });
    }
    this.datesList = list;
  }

  selectDate(index: number): void {
    this.selectedDateIndex = index;
  }

  toggleFavorite(hall: CinemaShowtime): void {
    hall.isFavorite = !hall.isFavorite;
  }

  onTimeClick(hall: CinemaShowtime, slot: ShowtimeSlot): void {
    this.selectedTime = slot.time;
    this.selectShowtime.emit({
      hallName: hall.hallName,
      time: slot.time,
      format: hall.format,
      date: this.datesList[this.selectedDateIndex]?.fullDate || new Date(),
    });
  }
}
