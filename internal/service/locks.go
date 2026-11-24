package service

import "sync"

type galleryLockEntry struct {
	mu   sync.Mutex
	refs int
}

// GalleryLocks serializes automatic and manual enrichment for the same
// gallery row.
type GalleryLocks struct {
	mu      sync.Mutex
	entries map[int64]*galleryLockEntry
}

// NewGalleryLocks builds an empty lock registry.
func NewGalleryLocks() *GalleryLocks {
	return &GalleryLocks{entries: make(map[int64]*galleryLockEntry)}
}

// Lock blocks until the gallery row lock is held and returns the unlock
// function.
func (g *GalleryLocks) Lock(id int64) func() {
	g.mu.Lock()
	entry := g.entries[id]
	if entry == nil {
		entry = &galleryLockEntry{}
		g.entries[id] = entry
	}
	entry.refs++
	g.mu.Unlock()

	entry.mu.Lock()
	return func() {
		entry.mu.Unlock()
		g.mu.Lock()
		entry.refs--
		if entry.refs == 0 {
			delete(g.entries, id)
		}
		g.mu.Unlock()
	}
}
