function padNumber(value: number, width = 2): string {
	return String(Math.trunc(Math.abs(value))).padStart(width, "0");
}

function toDate(value: number): Date {
	return new Date(value);
}

export function formatLocalTimestamp(value: number): string {
	const date = toDate(value);
	const offsetMinutes = -date.getTimezoneOffset();
	const sign = offsetMinutes >= 0 ? "+" : "-";
	const absoluteOffsetMinutes = Math.abs(offsetMinutes);

	return [
		`${padNumber(date.getFullYear(), 4)}-${padNumber(date.getMonth() + 1)}-${padNumber(date.getDate())}`,
		`T${padNumber(date.getHours())}:${padNumber(date.getMinutes())}:${padNumber(date.getSeconds())}`,
		`.${padNumber(date.getMilliseconds(), 3)}`,
		`${sign}${padNumber(Math.floor(absoluteOffsetMinutes / 60))}:${padNumber(absoluteOffsetMinutes % 60)}`,
	].join("");
}

export function formatLocalDate(value: number): string {
	const date = toDate(value);
	return `${padNumber(date.getFullYear(), 4)}-${padNumber(date.getMonth() + 1)}-${padNumber(date.getDate())}`;
}
