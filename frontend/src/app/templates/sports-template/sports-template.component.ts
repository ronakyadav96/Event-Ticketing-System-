import { Component, Input, Output, EventEmitter } from '@angular/core';
import { CommonModule, DatePipe } from '@angular/common';

@Component({
  standalone: true,
  selector: 'app-sports-template',
  imports: [CommonModule, DatePipe],
  templateUrl: './sports-template.component.html',
  styleUrls: ['./sports-template.component.css'],
})
export class SportsTemplateComponent {
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
