import { Component, Input, Output, EventEmitter, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';

export interface Seat {
  id: string;      // e.g. "A1"
  row: string;     // e.g. "A"
  number: number;  // e.g. 1
  tier: 'VIP' | 'Premium' | 'Standard';
  priceMultiplier: number; // e.g. 1.5, 1.2, 1.0
  isBooked: boolean;
}

@Component({
  standalone: true,
  selector: 'app-seat-picker',
  imports: [CommonModule],
  templateUrl: './seat-picker.component.html',
  styleUrls: ['./seat-picker.component.css'],
})
export class SeatPickerComponent implements OnInit {
  @Input() basePriceRupees = 500;
  @Input() maxSeats = 10;
  @Output() selectedSeatsChange = new EventEmitter<string[]>();
  @Output() seatsCountChange = new EventEmitter<number>();

  seatRows: { rowLabel: string; tier: 'VIP' | 'Premium' | 'Standard'; seats: Seat[] }[] = [];
  selectedSeatIds = new Set<string>();

  readonly tierPrices = {
    VIP: 1.5,
    Premium: 1.2,
    Standard: 1.0,
  };

  Math = Math;

  ngOnInit(): void {
    this.generateSeatMap();
  }

  generateSeatMap(): void {
    const config: { row: string; tier: 'VIP' | 'Premium' | 'Standard'; count: number }[] = [
      { row: 'A', tier: 'VIP', count: 8 },
      { row: 'B', tier: 'VIP', count: 8 },
      { row: 'C', tier: 'Premium', count: 10 },
      { row: 'D', tier: 'Premium', count: 10 },
      { row: 'E', tier: 'Premium', count: 10 },
      { row: 'F', tier: 'Standard', count: 12 },
      { row: 'G', tier: 'Standard', count: 12 },
    ];

    // Randomly mark a few seats as booked for realism
    const randomBooked = new Set(['A3', 'C5', 'D8', 'F2', 'G10']);

    this.seatRows = config.map((c) => ({
      rowLabel: c.row,
      tier: c.tier,
      seats: Array.from({ length: c.count }, (_, i) => {
        const id = `${c.row}${i + 1}`;
        return {
          id,
          row: c.row,
          number: i + 1,
          tier: c.tier,
          priceMultiplier: this.tierPrices[c.tier],
          isBooked: randomBooked.has(id),
        };
      }),
    }));
  }

  toggleSeat(seat: Seat): void {
    if (seat.isBooked) return;

    if (this.selectedSeatIds.has(seat.id)) {
      this.selectedSeatIds.delete(seat.id);
    } else {
      if (this.selectedSeatIds.size >= this.maxSeats) return;
      this.selectedSeatIds.add(seat.id);
    }

    const arr = Array.from(this.selectedSeatIds);
    this.selectedSeatsChange.emit(arr);
    this.seatsCountChange.emit(arr.length || 1);
  }

  isSelected(id: string): boolean {
    return this.selectedSeatIds.has(id);
  }

  get selectedSeatsList(): string[] {
    return Array.from(this.selectedSeatIds);
  }

  get calculateTotalPrice(): number {
    let total = 0;
    for (const r of this.seatRows) {
      for (const s of r.seats) {
        if (this.selectedSeatIds.has(s.id)) {
          total += Math.round(this.basePriceRupees * s.priceMultiplier);
        }
      }
    }
    return total;
  }
}
