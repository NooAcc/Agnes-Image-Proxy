package store

import (
	"context"
	"sync"
)

// storageGate coordinates immutable storage-configuration snapshots with
// original-image operations. Readers can run concurrently; a writer waits for
// every reader and blocks new readers while it waits, so a steady stream of
// readers cannot starve an update. The zero value is usable.
type storageGate struct {
	mu             sync.Mutex
	readers        int
	writer         bool
	waitingWriters int
	notify         chan struct{}
}

func (g *storageGate) broadcastLocked() {
	if g.notify == nil {
		g.notify = make(chan struct{})
		return
	}
	close(g.notify)
	g.notify = make(chan struct{})
}

func (g *storageGate) channelLocked() chan struct{} {
	if g.notify == nil {
		g.notify = make(chan struct{})
	}
	return g.notify
}

// acquire takes a shared or exclusive hold. It returns a release function and
// honors context cancellation while waiting.
func (g *storageGate) acquire(ctx context.Context, exclusive bool) (func(), error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	g.mu.Lock()
	if exclusive {
		g.waitingWriters++
		for g.writer || g.readers > 0 {
			ch := g.channelLocked()
			g.mu.Unlock()
			select {
			case <-ch:
			case <-ctx.Done():
				g.mu.Lock()
				g.waitingWriters--
				g.broadcastLocked()
				g.mu.Unlock()
				return nil, ctx.Err()
			}
			g.mu.Lock()
		}
		g.waitingWriters--
		g.writer = true
		g.mu.Unlock()
		return func() {
			g.mu.Lock()
			g.writer = false
			g.broadcastLocked()
			g.mu.Unlock()
		}, nil
	}

	for g.writer || g.waitingWriters > 0 {
		ch := g.channelLocked()
		g.mu.Unlock()
		select {
		case <-ch:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
		g.mu.Lock()
	}
	g.readers++
	g.mu.Unlock()
	return func() {
		g.mu.Lock()
		g.readers--
		if g.readers == 0 {
			g.broadcastLocked()
		}
		g.mu.Unlock()
	}, nil
}
