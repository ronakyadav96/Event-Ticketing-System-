import { Component, Input, Output, EventEmitter } from '@angular/core';
import { CommonModule, DatePipe } from '@angular/common';

@Component({
  standalone: true,
  selector: 'app-concert-template',
  imports: [CommonModule, DatePipe],
  templateUrl: './concert-template.component.html',
  styleUrls: ['./concert-template.component.css'],
})
export class ConcertTemplateComponent {
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
