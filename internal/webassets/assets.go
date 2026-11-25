// Package webassets embeds the built admin console. The frontend must be built
// before this package compiles; there is no placeholder fallback.
package webassets

import (
	"embed"
	"fmt"
	"io/fs"
)

//go:embed all:dist
var embedded embed.FS

// FS returns the embedded console documents rooted at dist.
func FS() (fs.FS, error) {
	sub, err := fs.Sub(embedded, "dist")
	if err != nil {
		return nil, fmt.Errorf("webassets: %w", err)
	}
	if _, err := fs.Stat(sub, "index.html"); err != nil {
		return nil, fmt.Errorf("webassets: frontend build is missing index.html: %w", err)
	}
	return sub, nil
}
