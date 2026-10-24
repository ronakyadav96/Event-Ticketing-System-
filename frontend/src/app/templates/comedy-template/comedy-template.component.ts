import { Component, Input, Output, EventEmitter } from '@angular/core';
import { CommonModule, DatePipe } from '@angular/common';

@Component({
  standalone: true,
  selector: 'app-comedy-template',
  imports: [CommonModule, DatePipe],
  templateUrl: './comedy-template.component.html',
  styleUrls: ['./comedy-template.component.css'],
})
export class ComedyTemplateComponent {
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
