import { decompressFrames, parseGIF } from "gifuct-js";
import { PNG } from "pngjs";

/** Один готовый кадр: data-URL картинки + задержка до следующего кадра. */
export type Frame = {
	dataUrl: string;
	delayMs: number;
};

/** Целевой размер кадра для кнопки (px). 144 = @2x, чётко на любом железе. */
const SIZE = 144;

/**
 * Декодирует GIF (Buffer) в массив готовых PNG-кадров в виде data-URL.
 *
 * gifuct-js даёт нам "пропатченные" кадры в формате RGBA + их dims/положение.
 * GIF может перерисовывать только часть картинки между кадрами (disposal),
 * поэтому мы ведём общий холст (canvas) и накатываем каждый патч поверх.
 * Затем масштабируем холст под SIZE x SIZE и кодируем в PNG.
 */
export async function decodeGifToFrames(buffer: Buffer): Promise<Frame[]> {
	// gifuct ожидает ArrayBuffer; берём срез именно нужной области буфера.
	const arrayBuffer = buffer.buffer.slice(
		buffer.byteOffset,
		buffer.byteOffset + buffer.byteLength,
	) as ArrayBuffer;
	const gif = parseGIF(arrayBuffer);
	const rawFrames = decompressFrames(gif, true);

	if (rawFrames.length === 0) {
		return [];
	}

	// Логический размер GIF.
	const gifWidth = gif.lsd.width;
	const gifHeight = gif.lsd.height;

	// Общий холст RGBA, который мы перерисовываем между кадрами.
	const canvas = new Uint8ClampedArray(gifWidth * gifHeight * 4);

	const frames: Frame[] = [];

	for (const frame of rawFrames) {
		const { dims, patch } = frame;

		// Накатываем патч кадра на холст в его позицию.
		for (let row = 0; row < dims.height; row++) {
			for (let col = 0; col < dims.width; col++) {
				const patchIndex = (row * dims.width + col) * 4;
				const a = patch[patchIndex + 3];

				// Прозрачные пиксели не затирают холст.
				if (a === 0) {
					continue;
				}

				const canvasX = dims.left + col;
				const canvasY = dims.top + row;
				if (canvasX < 0 || canvasX >= gifWidth || canvasY < 0 || canvasY >= gifHeight) {
					continue;
				}

				const canvasIndex = (canvasY * gifWidth + canvasX) * 4;
				canvas[canvasIndex] = patch[patchIndex];
				canvas[canvasIndex + 1] = patch[patchIndex + 1];
				canvas[canvasIndex + 2] = patch[patchIndex + 2];
				canvas[canvasIndex + 3] = a;
			}
		}

		// Масштабируем текущий холст под квадрат SIZE x SIZE (nearest-neighbour,
		// для маленькой кнопки этого с головой и быстро).
		const png = new PNG({ width: SIZE, height: SIZE });
		for (let y = 0; y < SIZE; y++) {
			const srcY = Math.floor((y / SIZE) * gifHeight);
			for (let x = 0; x < SIZE; x++) {
				const srcX = Math.floor((x / SIZE) * gifWidth);
				const src = (srcY * gifWidth + srcX) * 4;
				const dst = (y * SIZE + x) * 4;
				png.data[dst] = canvas[src];
				png.data[dst + 1] = canvas[src + 1];
				png.data[dst + 2] = canvas[src + 2];
				png.data[dst + 3] = canvas[src + 3];
			}
		}

		const pngBuffer = PNG.sync.write(png);
		const dataUrl = `data:image/png;base64,${pngBuffer.toString("base64")}`;

		// gifuct отдаёт delay в мс; если 0 — ставим разумный дефолт (100мс ~ 10fps).
		const delayMs = frame.delay && frame.delay > 0 ? frame.delay : 100;

		frames.push({ dataUrl, delayMs });
	}

	return frames;
}
