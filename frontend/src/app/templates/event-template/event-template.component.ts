import { Component, Input, Output, EventEmitter } from '@angular/core';
import { CommonModule, DatePipe } from '@angular/common';

@Component({
  standalone: true,
  selector: 'app-event-template',
  imports: [CommonModule, DatePipe],
  templateUrl: './event-template.component.html',
  styleUrls: ['./event-template.component.css'],
})
export class EventTemplateComponent {
  @Input() event: any;
  @Input() eventImageUrl = '';
  @Input() eventImgFailed = false;
  @Input() isFreeEvent = false;
  @Input() unitPriceRupees = 0;
  @Output() openBooking = new EventEmitter<void>();

  onImgError() {
    this.eventImgFailed = true;
  }
}
