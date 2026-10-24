import { Component, Input, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ChatService } from '../../services/chat.service';

@Component({
  selector: 'app-quick-suggestions',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './quick-suggestions.component.html',
  styleUrls: ['./quick-suggestions.component.scss'],
})
export class QuickSuggestionsComponent {
  @Input() chips: string[] = [];

  readonly chat = inject(ChatService);

  onChipClick(chip: string): void {
    this.chat.sendQuickReply(chip);
  }
}

