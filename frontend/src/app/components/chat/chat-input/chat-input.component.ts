import { Component, ElementRef, NgZone, OnDestroy, ViewChild, inject, signal } from '@angular/core';
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
export class ChatInputComponent implements OnDestroy {
  readonly chat = inject(ChatService);
  private zone = inject(NgZone);
  inputText = '';

  /** Voice input (Web Speech API). en-IN also transcribes Hinglish speech in Roman script. */
  private readonly SpeechRecognition: any =
    typeof window !== 'undefined' ? (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition : null;
  readonly canListen = !!this.SpeechRecognition;
  readonly listening = signal(false);
  private recognition: any = null;

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

  toggleVoice(): void {
    if (this.listening()) {
      this.recognition?.stop();
      return;
    }
    if (!this.canListen || this.chat.isSending()) return;
    const rec = new this.SpeechRecognition();
    rec.lang = 'en-IN';
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    rec.onresult = (event: any) => {
      const transcript = Array.from(event.results as ArrayLike<any>)
        .map((r: any) => r[0]?.transcript || '')
        .join('');
      const final = event.results[event.results.length - 1]?.isFinal;
      this.zone.run(() => {
        this.inputText = transcript;
        if (final) this.onSubmit();
      });
    };
    rec.onend = () => this.zone.run(() => this.listening.set(false));
    rec.onerror = () => this.zone.run(() => this.listening.set(false));
    this.recognition = rec;
    this.listening.set(true);
    rec.start();
  }

  ngOnDestroy(): void {
    this.recognition?.abort?.();
  }

  autoGrow(el: HTMLTextAreaElement): void {
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }
}
