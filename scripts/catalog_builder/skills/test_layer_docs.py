from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import layer_docs  # noqa: E402
from publish_catalog import publish_docs  # noqa: E402

ENTRY = "92d7a79b-68ba-47f7-b4e4-ef4d5757a966"
BASE = "https://example.org/bucket"
URL = f"{BASE}/docs/layers/{ENTRY}/v1/index.html"


def catalog(documentation: str | None = URL) -> dict:
    entry = {"id": ENTRY, **({"documentation": documentation} if documentation else {})}
    return {"layers": [entry]}


def registry(version: int = 1, file: str = "METHODOLOGY.md") -> dict:
    return {"upload": {"prefix": "docs/layers"},
            "docs": [{"catalogEntryId": ENTRY, "file": file, "version": version}]}


class FakeClientError(Exception):
    """Shaped like botocore's ClientError: the S3 error code under `response`."""

    def __init__(self, code: str):
        super().__init__(code)
        self.response = {"Error": {"Code": code}}


class FakeS3:
    class exceptions:  # noqa: N801 - mirrors boto3
        ClientError = FakeClientError

    def __init__(self, objects: dict[str, dict] | None = None, error: str = "404"):
        self.objects = objects or {}
        self.error = error
        self.puts: list[str] = []

    def head_object(self, Bucket: str, Key: str) -> dict:  # noqa: N803
        if Key not in self.objects:
            raise FakeClientError(self.error)
        return {"Metadata": self.objects[Key]}

    def put_object(self, Bucket: str, Key: str, Metadata: dict, **_: object) -> None:  # noqa: N803
        self.objects[Key] = Metadata
        self.puts.append(Key)


class LayerDocsTest(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        (self.root / "METHODOLOGY.md").write_text("# Malé\n\n| a | b |\n| - | - |\n| 1 | 2 |\n")

    def test_accepts_a_link_to_the_registered_version(self):
        self.assertEqual(layer_docs.check(catalog(), registry(), self.root, BASE), [])

    def test_rejects_a_link_to_another_version_or_a_missing_source(self):
        errors = layer_docs.check(catalog(), registry(version=2, file="missing.md"), self.root, BASE)
        self.assertEqual(len(errors), 2)
        self.assertIn("not found", errors[0])
        self.assertIn("/v2/index.html", errors[1])

    def test_rejects_a_link_to_another_host_or_bucket(self):
        errors = layer_docs.check(catalog(URL.replace("/bucket/", "/other/")), registry(), self.root, BASE)
        self.assertEqual(errors, [f"{ENTRY}: documentation must link to {URL}"])

    def test_links_to_the_committed_public_bucket(self):
        self.assertEqual(layer_docs.public_base(), "https://sos-ch-gva-2.exo.io/mapx-zartigl")

    def test_rejects_a_link_without_a_source(self):
        errors = layer_docs.check(catalog(), {"upload": {"prefix": "docs/layers"}, "docs": []}, self.root, BASE)
        self.assertEqual(errors, [f"{ENTRY}: documentation has no source in scripts/catalog_builder/docs.json"])

    def test_renders_a_standalone_page_with_its_permanent_link(self):
        pages = layer_docs.pages(catalog(), registry(), self.root)
        self.assertEqual([page["key"] for page in pages],
                         [f"docs/layers/{ENTRY}/v1/index.html", f"docs/layers/{ENTRY}/index.html"])
        page = pages[0]["body"].decode()
        self.assertIn("<title>Malé</title>", page)
        self.assertIn(f'<link rel="canonical" href="{URL}">', page)
        self.assertIn('<div class="table"><table>', page)

    def test_publishes_new_pages_and_keeps_published_versions(self):
        client = FakeS3()
        pages = layer_docs.pages(catalog(), registry(), self.root)
        self.assertEqual(publish_docs(client, "bucket", pages), [])
        self.assertEqual(len(client.puts), 2)
        self.assertEqual(publish_docs(client, "bucket", pages), [])
        self.assertEqual(len(client.puts), 2)

    def test_refuses_to_rewrite_a_published_version_with_a_changed_source(self):
        client = FakeS3()
        publish_docs(client, "bucket", layer_docs.pages(catalog(), registry(), self.root))
        (self.root / "METHODOLOGY.md").write_text("# Malé, edited\n")
        errors = publish_docs(client, "bucket", layer_docs.pages(catalog(), registry(), self.root))
        self.assertEqual(len(errors), 1)
        self.assertIn("bump its version", errors[0])
        self.assertEqual(len(client.puts), 2)

    def test_stops_when_the_bucket_cannot_say_whether_a_version_exists(self):
        for code in ("403", "AccessDenied", "500"):
            client = FakeS3(error=code)
            with self.assertRaises(FakeClientError):
                publish_docs(client, "bucket", layer_docs.pages(catalog(), registry(), self.root))
            self.assertEqual(client.puts, [])

    def test_creates_a_page_only_when_the_bucket_reports_it_missing(self):
        for code in ("404", "NoSuchKey", "NotFound"):
            client = FakeS3(error=code)
            self.assertEqual(publish_docs(client, "bucket", layer_docs.pages(catalog(), registry(), self.root)), [])
            self.assertEqual(len(client.puts), 2)


if __name__ == "__main__":
    unittest.main()
