FROM alpine:edge as builder
RUN apk add bash make findutils
RUN mkdir /usr/src

# # Build smu
# WORKDIR /usr/src
# RUN git clone https://github.com/gottox/smu.git
# WORKDIR /usr/src/smu
# RUN make
# RUN make install

# Copy site source
RUN mkdir -p /usr/src/app
COPY . /usr/src/app

# Build the site
WORKDIR /usr/src/app
RUN make

# Make the runner container
FROM alpine:edge
RUN echo "https://dl-cdn.alpinelinux.org/alpine/edge/testing" >> /etc/apk/repositories
RUN apk --no-cache add quark
COPY --from=builder /usr/src/app/docs /app
WORKDIR /app
EXPOSE 80
ENTRYPOINT ["/usr/bin/quark"]
CMD ["-h", "0.0.0.0", "-p", "80", "-d", "/app"]
