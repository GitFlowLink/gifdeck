import streamDeck, { LogLevel } from "@elgato/streamdeck";

import { GifAction } from "./actions/gif-action";

// Уровень логов. INFO достаточно; для отладки можно поставить TRACE.
streamDeck.logger.setLevel(LogLevel.INFO);

// Регистрируем наш action.
streamDeck.actions.registerAction(new GifAction());

// Подключаемся к Stream Deck / OpenDeck.
streamDeck.connect();
