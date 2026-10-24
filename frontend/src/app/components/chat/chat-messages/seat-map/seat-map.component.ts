import { Component, Input, OnChanges, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { SeatMap } from '../../models/chat.models';
import { ChatService } from '../../services/chat.service';

/** Seat picker for the SELECT_SEATS step. Selection is sent to the server, which validates it. */
@Component({
  selector: 'app-seat-map',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './seat-map.component.html',
  styleUrls: ['./seat-map.component.scss'],
})
export class SeatMapComponent implements OnChanges {
  @Input({ required: true }) map!: SeatMap;
  @Input() required = 0;

  private chat = inject(ChatService);
  private unavailable = new Set<string>();
  selected: string[] = [];

  ngOnChanges(): void {
    this.unavailable = new Set(this.map?.unavailable || []);
    this.selected = [...(this.map?.selected || [])];
  }

  isTaken(seat: string): boolean {
    return this.unavailable.has(seat);
  }

  toggle(seat: string): void {
    if (this.isTaken(seat)) return;
    if (this.selected.includes(seat)) {
      this.selected = this.selected.filter((s) => s !== seat);
    } else if (this.selected.length < this.required) {
      this.selected = [...this.selected, seat];
    }
  }

  submit(): void {
    if (this.selected.length === this.required) {
      this.chat.sendMessage(`Seats ${this.selected.join(', ')}`);
    }
  }
}
