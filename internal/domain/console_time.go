package domain

import "time"

var consoleZone = time.FixedZone("UTC+8", 8*60*60)

// ConsoleTime converts an instant to the fixed UTC+8 management time zone.
// It does not depend on the host time zone or installed tzdata.
func ConsoleTime(t time.Time) time.Time { return t.In(consoleZone) }
