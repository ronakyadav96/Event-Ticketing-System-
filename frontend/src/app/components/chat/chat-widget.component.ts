import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ChatService } from './services/chat.service';
import { ChatHeaderComponent } from './chat-header/chat-header.component';
import { ChatMessagesComponent } from './chat-messages/chat-messages.component';
import { QuickSuggestionsComponent } from './chat-messages/quick-suggestions/quick-suggestions.component';
import { ChatInputComponent } from './chat-input/chat-input.component';

@Component({
  selector: 'app-chat-widget',
  standalone: true,
  imports: [
    CommonModule,
    ChatHeaderComponent,
    ChatMessagesComponent,
    QuickSuggestionsComponent,
    ChatInputComponent,
  ],
  templateUrl: './chat-widget.component.html',
  styleUrls: ['./chat-widget.component.scss'],
})
export class ChatWidgetComponent {
  readonly chat = inject(ChatService);

  onCloseHistory(): void {
    this.chat.toggleHistory(false);
  }

  onNewChatClick(): void {
    this.chat.startNewChat();
  }

  onSelectConversation(convId: string): void {
    this.chat.switchConversation(convId);
  }

  onDeleteConversation(convId: string, event: Event): void {
    event.stopPropagation();
    if (confirm('Delete this conversation thread permanently?')) {
      this.chat.deleteConversation(convId);
    }
  }
}

