package panel

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

type giteeTransport struct{ address *url.URL }

func (r giteeTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	copy := req.Clone(req.Context())
	if copy.URL.Host == "gitee.com" {
		copy.URL.Scheme = r.address.Scheme
		copy.URL.Host = r.address.Host
	}
	return http.DefaultTransport.RoundTrip(copy)
}

func giteeFixture(t *testing.T, change func(*releaseIndex, map[string]releaseAsset)) (GiteeSource, string) {
	t.Helper()
	sha := strings.Repeat("a", 40)
	body := releaseArchive(t, sha, runtime.GOARCH, nil)
	sum := sha256.Sum256(body)
	index := releaseIndex{Schema: releaseIndexSchema, Repository: Repository, Commit: sha, OS: "linux", Artifacts: map[string]indexedArtifact{}}
	assets := map[string]releaseAsset{}
	base := "https://gitee.com/" + GiteeRepository + "/releases/download/v1.2.0/"
	for _, arch := range []string{"amd64", "arm64"} {
		name := "elysian-linux-" + arch + ".tar.gz"
		index.Artifacts[arch] = indexedArtifact{Name: name, Size: int64(len(body)), SHA256: hex.EncodeToString(sum[:])}
		assets[name] = releaseAsset{Name: name, Size: int64(len(body)), URL: base + name}
		assets[name+".sha256"] = releaseAsset{Name: name + ".sha256", Size: 93, URL: base + name + ".sha256"}
	}
	assets["release-index.json"] = releaseAsset{Name: "release-index.json", Size: 1, URL: base + "release-index.json"}
	if change != nil {
		change(&index, assets)
	}
	encoded, _ := json.Marshal(index)
	if marker, ok := assets["release-index.json"]; ok {
		marker.Size = int64(len(encoded))
		assets[marker.Name] = marker
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.Contains(r.URL.Path, "/releases/download/"):
			if strings.HasSuffix(r.URL.Path, "release-index.json") {
				w.Write(encoded)
			} else {
				w.Write(body)
			}
		case strings.HasSuffix(r.URL.Path, "/attach_files"):
			if strings.Contains(r.URL.Path, "/releases/3/") {
				w.Write([]byte(`[]`))
				return
			}
			rows := []releaseAsset{}
			for _, a := range assets {
				rows = append(rows, a)
			}
			json.NewEncoder(w).Encode(rows)
		case strings.HasSuffix(r.URL.Path, "/tags"):
			json.NewEncoder(w).Encode([]any{map[string]any{"name": "v1.2.0", "commit": map[string]string{"sha": sha}}, map[string]any{"name": "v1.3.0", "commit": map[string]string{"sha": strings.Repeat("b", 40)}}})
		case strings.Contains(r.URL.Path, "/releases/tags/"):
			tag := r.URL.Path[strings.LastIndex(r.URL.Path, "/")+1:]
			id := 2
			if tag == "v1.3.0" {
				id = 3
			}
			json.NewEncoder(w).Encode(map[string]any{"id": id, "tag_name": tag, "prerelease": false})
		case strings.HasSuffix(r.URL.Path, "/releases"):
			if r.URL.Query().Get("direction") != "desc" {
				t.Error("Gitee 默认升序，必须指定 desc")
			}
			json.NewEncoder(w).Encode([]any{map[string]any{"id": 3, "tag_name": "v1.3.0", "prerelease": false}, map[string]any{"id": 1, "tag_name": "build-" + sha, "prerelease": true}, map[string]any{"id": 2, "tag_name": "v1.2.0", "name": "正式版", "prerelease": false}})
		case strings.HasSuffix(r.URL.Path, "/commits"):
			if r.URL.Query().Get("sha") != sha {
				t.Error("history did not use pinned SHA")
			}
			w.Write([]byte(`[]`))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)
	address, _ := url.Parse(server.URL)
	return GiteeSource{API: server.URL, Client: &http.Client{Transport: giteeTransport{address}}}, sha
}

func TestGiteePinnedDownloadAndReleaseSelection(t *testing.T) {
	source, sha := giteeFixture(t, nil)
	for _, channel := range []UpdateChannel{ChannelCommit, ChannelRelease} {
		update, err := source.Check(context.Background(), channel)
		if err != nil || update.TargetCommit != sha || update.Source != SourceGitee {
			t.Fatalf("%+v %v", update, err)
		}
		if channel == ChannelRelease && update.ReleaseTag != "v1.2.0" {
			t.Fatal("preview selected as formal release")
		}
		if _, err := source.History(context.Background(), channel, 30); err != nil {
			t.Fatal(err)
		}
	}
	if err := source.Download(context.Background(), sha, filepath.Join(t.TempDir(), "bundle")); err != nil {
		t.Fatal(err)
	}
}

func TestGiteeRejectsIncompleteOrInvalidPublishedArtifacts(t *testing.T) {
	for _, name := range []string{"marker", "arch", "commit", "digest", "foreign-url", "size", "content"} {
		t.Run(name, func(t *testing.T) {
			source, sha := giteeFixture(t, func(index *releaseIndex, assets map[string]releaseAsset) {
				switch name {
				case "marker":
					delete(assets, "release-index.json")
				case "arch":
					delete(assets, "elysian-linux-arm64.tar.gz")
				case "commit":
					index.Commit = strings.Repeat("b", 40)
				case "digest":
					item := index.Artifacts["amd64"]
					item.SHA256 = "not-a-digest"
					index.Artifacts["amd64"] = item
				case "foreign-url":
					item := assets["release-index.json"]
					item.URL = "https://example.com/index"
					assets[item.Name] = item
				case "size":
					item := index.Artifacts["arm64"]
					item.Size++
					index.Artifacts["arm64"] = item
				case "content":
					item := index.Artifacts[runtime.GOARCH]
					item.SHA256 = strings.Repeat("0", 64)
					index.Artifacts[runtime.GOARCH] = item
				}
			})
			if err := source.Download(context.Background(), sha, filepath.Join(t.TempDir(), "bundle")); err == nil {
				t.Fatal("invalid release accepted")
			}
		})
	}
}

func TestGiteeRoutesAndTasksKeepExactSource(t *testing.T) {
	w, original, h := setupWorker(t, "update")
	gh, gt := &channelSource{}, &channelSource{}
	if err := os.Remove(w.Store.taskPath(original.ID)); err != nil {
		t.Fatal(err)
	}
	m := Manager{Store: w.Store, Host: h, Source: gh, Sources: map[UpdateSource]Source{SourceGitee: gt}, Ports: original.OldPorts, Enabled: true, Executable: filepath.Join(w.install(), "releases", "old", "elysian")}
	u, err := m.CheckFrom(context.Background(), ChannelCommit, SourceGitee)
	if err != nil || u.Source != SourceGitee || len(gh.checked) != 0 {
		t.Fatalf("%+v %v", u, err)
	}
	input := submitInput{RequestID: "gitee-source", Source: SourceGitee, Channel: ChannelCommit, TargetCommit: u.TargetCommit}
	task, err := m.Submit(context.Background(), "update", input, "")
	if err != nil || task.UpdateSource != SourceGitee || task.UpdateDelivery != PrecompiledDelivery {
		t.Fatalf("%+v %v", task, err)
	}
	input.Source = SourceGitHub
	if _, err := m.Submit(context.Background(), "update", input, ""); err == nil {
		t.Fatal("request source changed")
	}
}

func TestGiteeExplicitCommitDoesNotAcceptOtherPublishedCommit(t *testing.T) {
	source, _ := giteeFixture(t, nil)
	if _, err := source.findRelease(context.Background(), strings.Repeat("c", 40)); err == nil {
		t.Fatal("an unpublished SHA was accepted")
	}
}
