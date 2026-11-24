package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"syscall"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := Run(ctx, os.Args[1:], os.Getenv, os.Stdout, os.Stderr); err != nil {
		fmt.Fprintln(os.Stderr, "agnes-proxy:", err)
		os.Exit(1)
	}
}
