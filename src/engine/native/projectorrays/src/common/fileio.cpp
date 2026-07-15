/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

#include <array>
#include <fstream>

#include "common/fileio.h"
#include "common/stream.h"

namespace Common {

static WriteStats g_writeStats = { 0, 0 };

static void writeBytes(const std::filesystem::path &path, const char *contents, size_t size) {
	std::array<char, 65536> buffer;
	std::ofstream f;
	f.rdbuf()->pubsetbuf(buffer.data(), buffer.size());
	f.open(path, std::ios::out | std::ios::binary | std::ios::trunc);
	f.write(contents, size);
	f.close();
	g_writeStats.files += 1;
	g_writeStats.bytes += size;
}

bool readFile(const std::filesystem::path &path, std::vector<uint8_t> &buf) {
	std::ifstream f;
	f.open(path, std::ios::in | std::ios::binary);

	if (f.fail())
		return false;

	f.seekg(0, std::ios::end);
	auto fileSize = f.tellg();
	f.seekg(0, std::ios::beg);
	buf.resize(fileSize);
	f.read((char *)buf.data(), fileSize);
	f.close();

	return true;
}

void writeFile(const std::filesystem::path &path, const std::string &contents) {
	writeBytes(path, contents.data(), contents.size());
}

void writeFile(const std::filesystem::path &path, const uint8_t *contents, size_t size) {
	writeBytes(path, reinterpret_cast<const char *>(contents), size);
}

void writeFile(const std::filesystem::path &path, const BufferView &view) {
	writeFile(path, view.data(), view.size());
}

WriteStats writeStats() {
	return g_writeStats;
}

} // namespace Common
