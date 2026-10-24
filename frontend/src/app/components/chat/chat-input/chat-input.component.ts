import { Component, ElementRef, ViewChild, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ChatService } from '../services/chat.service';

@Component({
  selector: 'app-chat-input',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './chat-input.component.html',
  styleUrls: ['./chat-input.component.scss'],
})
export class ChatInputComponent {
  readonly chat = inject(ChatService);
  inputText = '';

  @ViewChild('box') private box?: ElementRef<HTMLTextAreaElement>;

  onKeyDown(event: KeyboardEvent): void {
    // Enter sends; Shift+Enter adds a line. Ignore Enter while an IME is composing.
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      this.onSubmit();
    }
  }

  onSubmit(): void {
    const text = this.inputText.trim();
    if (!text || this.chat.isSending()) return;
    this.chat.sendMessage(text);
    this.inputText = '';
    if (this.box) {
      this.box.nativeElement.style.height = '';
    }
  }

  autoGrow(el: HTMLTextAreaElement): void {
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }
}
