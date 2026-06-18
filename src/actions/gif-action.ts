import {
	action,
	DidReceiveSettingsEvent,
	KeyDownEvent,
	SendToPluginEvent,
	JsonValue,
	SingletonAction,
	WillAppearEvent,
	WillDisappearEvent,
	streamDeck,
} from "@elgato/streamdeck";
import { exec } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { decodeGifToFrames, Frame } from "../gif";

/** Логирование через штатный логгер SDK (пишет в logs/ плагина). */
async function dbg(msg: string): Promise<void> {
	streamDeck.logger.info(msg);
}

/**
 * Открывает системный диалог выбора файла и возвращает абсолютный путь.
 * Сначала пробует kdialog (KDE), затем zenity (GTK). Если оба отсутствуют
 * или пользователь отменил — возвращает null.
 */
function pickGifFile(): Promise<string | null> {
	return new Promise((resolve) => {
		const tryKdialog = (): void => {
			exec(
				`kdialog --getopenfilename "$HOME" "image/gif"`,
				(err, stdout) => {
					if (!err && stdout.trim()) {
						resolve(stdout.trim());
					} else {
						tryZenity();
					}
				},
			);
		};

		const tryZenity = (): void => {
			exec(
				`zenity --file-selection --file-filter='GIF | *.gif'`,
				(err, stdout) => {
					if (!err && stdout.trim()) {
						resolve(stdout.trim());
					} else {
						resolve(null);
					}
				},
			);
		};

		tryKdialog();
	});
}

/**
 * Настройки, которые пользователь задаёт в Property Inspector.
 */
type GifSettings = {
	/** Абсолютный путь к .gif файлу. */
	gifPath?: string;
	/** Команда, выполняемая при нажатии на кнопку (необязательно). */
	command?: string;
	/** Множитель скорости (1 = как в самом GIF). */
	speed?: number;
};

/**
 * Состояние анимации для конкретного экземпляра кнопки.
 * У каждой кнопки на деке свой context (id), поэтому храним по нему.
 */
type AnimationState = {
	frames: Frame[];
	index: number;
	timer: NodeJS.Timeout | null;
	/** Идентификатор поколения. tick останавливается, если оно устарело. */
	generation: number;
	/** Какой путь сейчас играет — для отсева дублирующих/устаревших запросов. */
	path: string;
};

@action({ UUID: "dev.gitflowlink.gifdeck.player" })
export class GifAction extends SingletonAction<GifSettings> {
	/** Карта: context кнопки -> состояние её анимации. */
	private readonly animations = new Map<string, AnimationState>();

	/** Монотонный счётчик поколений анимаций (для борьбы с гонкой при смене GIF). */
	private generationCounter = 0;

	/**
	 * Кнопка появилась на экране (запуск дека / переход на страницу).
	 * Здесь стартуем анимацию.
	 */
	override async onWillAppear(ev: WillAppearEvent<GifSettings>): Promise<void> {
		await this.startAnimation(ev.action.id, ev.payload.settings, ev.action);
	}

	/**
	 * Кнопка скрылась — обязательно гасим таймер, иначе утечка.
	 */
	override onWillDisappear(ev: WillDisappearEvent<GifSettings>): void {
		this.stopAnimation(ev.action.id);
	}

	/**
	 * Пользователь поменял настройки в Property Inspector — перезапускаем.
	 */
	override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<GifSettings>): Promise<void> {
		// stopAnimation не нужен: startAnimation создаёт новое поколение,
		// и старый цикл сам завершится при следующем тике.
		await this.startAnimation(ev.action.id, ev.payload.settings, ev.action);
	}

	/**
	 * Сообщение от Property Inspector. Используем для кнопки "Browse":
	 * запускаем системный диалог выбора файла (kdialog/zenity) и сохраняем путь.
	 */
	override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, GifSettings>): Promise<void> {
		await dbg(`onSendToPlugin payload: ${JSON.stringify(ev.payload)}`);
		const payload = ev.payload as { event?: string } | undefined;
		if (payload?.event !== "browse") {
			return;
		}

		await dbg("Browse requested, opening file dialog");

		const path = await pickGifFile();
		if (!path) {
			await dbg("Dialog cancelled or returned empty");
			return;
		}

		await dbg(`Dialog returned: "${path}"`);

		// Берём текущие настройки только ради command/speed, а gifPath
		// выставляем из диалога (он точно свежий, в отличие от кэша getSettings).
		const current = await ev.action.getSettings();
		const newSettings: GifSettings = {
			...current,
			gifPath: path,
		};

		// Пишем в настройки (чтобы поле в PI обновилось и значение сохранилось).
		await ev.action.setSettings(newSettings);

		// И СРАЗУ запускаем анимацию с гарантированно правильным путём.
		// На onDidReceiveSettings не полагаемся — он приходит с задержкой и
		// иногда с устаревшим gifPath (off-by-one, который мы и ловили).
		await this.startAnimation(ev.action.id, newSettings, ev.action as never);
	}

	/**
	 * Нажатие на кнопку — если задана команда, выполняем её.
	 */
	override onKeyDown(ev: KeyDownEvent<GifSettings>): void {
		const command = ev.payload.settings.command?.trim();
		if (!command) {
			return;
		}

		exec(command, (error) => {
			if (error) {
				streamDeck.logger.error(`Command failed: ${error.message}`);
			}
		});
	}

	/**
	 * Декодирует GIF и запускает цикл смены кадров через setImage.
	 */
	private async startAnimation(
		context: string,
		settings: GifSettings,
		actionApi: WillAppearEvent<GifSettings>["action"],
	): Promise<void> {
		const rawPath = settings.gifPath?.trim();
		await dbg(`startAnimation called. raw settings: ${JSON.stringify(settings)}`);
		if (!rawPath) {
			// Путь не задан — показываем подсказку и выходим.
			await dbg("No path set, showing 'Set GIF'");
			await actionApi.setTitle("Set GIF");
			return;
		}

		// Раскрываем ~ в домашнюю директорию.
		const path = rawPath.startsWith("~")
			? join(homedir(), rawPath.slice(1))
			: rawPath;

		// Защита от устаревшего onDidReceiveSettings: если эта же гифка уже
		// играет (живой таймер на тот же путь), повторный запуск игнорируем.
		// Именно это отсекает лагающее событие со старым gifPath.
		const existing = this.animations.get(context);
		if (existing && existing.path === path && existing.frames.length > 0) {
			await dbg(`Already playing "${path}", ignoring duplicate start`);
			return;
		}

		// Новое поколение присваиваем СРАЗУ и пишем в map — это мгновенно
		// "убивает" предыдущий цикл анимации ещё до того, как мы начнём
		// долгое декодирование нового GIF. Иначе старый цикл успевает
		// показать свои кадры, пока новый декодится (off-by-one мигание).
		const generation = ++this.generationCounter;
		this.animations.set(context, { frames: [], index: 0, timer: null, generation, path });

		await dbg(`Loading GIF from path: "${path}" (gen ${generation})`);

		let frames: Frame[];
		try {
			const buffer = await readFile(path);
			await dbg(`File read OK, ${buffer.length} bytes. Decoding...`);
			frames = await decodeGifToFrames(buffer);
			await dbg(`Decoded ${frames.length} frames`);
		} catch (err) {
			await dbg(`ERROR: ${String(err)}\n${err instanceof Error ? err.stack : ""}`);
			await actionApi.setTitle("GIF error");
			return;
		}

		// Пока декодировали, мог прийти ещё более новый запрос — проверяем.
		const afterDecode = this.animations.get(context);
		if (!afterDecode || afterDecode.generation !== generation) {
			await dbg(`gen ${generation} superseded during decode, aborting`);
			return;
		}

		if (frames.length === 0) {
			await actionApi.setTitle("Empty GIF");
			return;
		}

		// Один кадр — это просто статичная картинка, таймер не нужен.
		if (frames.length === 1) {
			await actionApi.setImage(frames[0].dataUrl);
			this.animations.set(context, { frames, index: 0, timer: null, generation, path });
			return;
		}

		const state: AnimationState = { frames, index: 0, timer: null, generation, path };
		this.animations.set(context, state);

		const speed = settings.speed && settings.speed > 0 ? settings.speed : 1;

		const tick = async (): Promise<void> => {
			// Если для этой кнопки уже стартовало другое поколение — выходим.
			// Это убивает гонку при быстрой смене GIF (два цикла на одну кнопку).
			const live = this.animations.get(context);
			if (!live || live.generation !== generation) {
				return;
			}

			const current = state.frames[state.index];
			await actionApi.setImage(current.dataUrl);

			// Ещё одна проверка после await — настройки могли смениться, пока ждали.
			const stillLive = this.animations.get(context);
			if (!stillLive || stillLive.generation !== generation) {
				return;
			}

			// Длительность кадра из самого GIF (мс), c защитой от слишком быстрых.
			const delay = Math.max(20, current.delayMs / speed);
			state.index = (state.index + 1) % state.frames.length;
			state.timer = setTimeout(tick, delay);
		};

		await tick();
	}

	/**
	 * Останавливает анимацию и чистит состояние.
	 */
	private stopAnimation(context: string): void {
		const state = this.animations.get(context);
		if (state?.timer) {
			clearTimeout(state.timer);
		}
		this.animations.delete(context);
	}
}
