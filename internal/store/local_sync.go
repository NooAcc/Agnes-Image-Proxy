//go:build !windows

package store

import (
	"errors"
	"os"
	"path"
)

// Sync bottom-up: durable file bytes alone do not persist a new directory entry.
func syncDirectoryChain(root *os.Root, dir string) error {
	for {
		file, err := root.Open(dir)
		if err != nil {
			return err
		}
		err = errors.Join(file.Sync(), file.Close())
		if err != nil {
			return err
		}
		if dir == "." {
			return nil
		}
		dir = path.Dir(dir)
	}
}
